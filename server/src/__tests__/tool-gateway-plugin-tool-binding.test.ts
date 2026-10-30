import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
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
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type TestDb = ReturnType<typeof createDb>;

const wikiReadPageContent = "# Wiki page\n\nRead-back body.";

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
        name: "a.b:wiki_append_log",
        displayName: "Append Wiki Log",
        description: "A mutating tool from plugin a.b.",
        parametersSchema: { type: "object" },
        pluginId: "plugin-a",
      },
      {
        name: "wiki_append_log",
        displayName: "Append Wiki Log (unscoped)",
        description: "A mutating unscoped tool.",
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
      {
        name: "a.b:wiki_read_page",
        displayName: "Read Wiki Page",
        description: "A schema-strict wiki read tool.",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: { type: "string" },
            wikiId: { type: "string" },
            path: { type: "string" },
          },
          required: ["companyId", "wikiId", "path"],
          additionalProperties: false,
        },
        pluginId: "plugin-a",
      },
    ],
    getTool: () => null,
    executeTool: async (tool) => {
      if (tool === "a.b:wiki_read_page") {
        return {
          pluginId: "plugin-a",
          toolName: "wiki_read_page",
          result: {
            content: wikiReadPageContent,
            data: {
              hash: createHash("sha256").update(wikiReadPageContent).digest("hex"),
            },
          },
        };
      }
      return {
        pluginId: "plugin-a",
        toolName: "alpha",
        result: { data: { ok: true } },
      };
    },
    registerPluginTools: () => {},
    unregisterPluginTools: () => {},
    toolCount: () => 5,
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
  await db.insert(toolPolicies).values({
    companyId,
    name: "Allow a.b:wiki_append_log",
    policyType: "allow",
    selectors: { toolName: "a.b:wiki_append_log" },
  });
  await db.insert(toolPolicies).values({
    companyId,
    name: "Allow wiki_append_log",
    policyType: "allow",
    selectors: { toolName: "wiki_append_log" },
  });
  await db.insert(toolPolicies).values({
    companyId,
    name: "Allow a.b:wiki_read_page",
    policyType: "allow",
    selectors: { toolName: "a.b:wiki_read_page" },
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

  it("publishes wiki_append_log as a write-risk plugin tool", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const tools = await gateway.listToolsForSession(session.token);
    expect(tools.find((entry) => entry.name === "a.b:wiki_append_log")).toMatchObject({
      providerType: "paperclip_plugin",
      risk: "write",
    });
    expect(tools.find((entry) => entry.name === "wiki_append_log")).toMatchObject({
      providerType: "paperclip_plugin",
      risk: "write",
    });
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

  it("preserves an unredacted plugin dispatch result", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });

    await expect(gateway.executePluginTool({
      actor: { type: "agent", companyId: company.id, agentId: agent.id, runId: run.id },
      tool: "a.b:alpha",
      parameters: {},
      runContext: { companyId: company.id, agentId: agent.id, runId: run.id, projectId: "" },
    })).resolves.toEqual({
      pluginId: "plugin-a",
      toolName: "alpha",
      result: { data: { ok: true } },
    });
  });

  it("rehashes redacted content inside the production plugin dispatch envelope", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const secret = "plugin-result-secret";
    const originalContent = `Authorization: Bearer ${secret}`;
    const dispatcher = twoPluginDispatcher();
    const gateway = createToolGatewayService(db, {
      pluginToolDispatcher: {
        ...dispatcher,
        executeTool: async (tool, parameters, runContext) => {
          const result = await dispatcher.executeTool(tool, parameters, runContext);
          return {
            ...result,
            result: {
              content: originalContent,
              data: { hash: createHash("sha256").update(originalContent).digest("hex") },
            },
          };
        },
      },
    });
    const result = await gateway.executePluginTool({
      actor: { type: "agent", companyId: company.id, agentId: agent.id, runId: run.id },
      tool: "a.b:alpha",
      parameters: {},
      runContext: { companyId: company.id, agentId: agent.id, runId: run.id, projectId: "" },
    });

    expect(result).toEqual({
      pluginId: "plugin-a",
      toolName: "alpha",
      result: {
        content: "Authorization: ***REDACTED***",
        data: {
          hash: createHash("sha256").update("Authorization: ***REDACTED***").digest("hex"),
        },
        redacted: true,
        redactedFields: ["sensitive_value"],
      },
    });
    expect(result).toMatchObject({ pluginId: "plugin-a", toolName: "alpha", result: expect.any(Object) });
    const checkedResult = result as unknown as {
      result: { content?: unknown; data?: unknown };
    };
    const content = checkedResult.result.content;
    const data = checkedResult.result.data;
    if (
      typeof content !== "string" ||
      typeof data !== "object" ||
      data === null ||
      !("hash" in data) ||
      typeof data.hash !== "string"
    ) {
      throw new Error("Expected a plugin result with string content and hash data");
    }
    expect(createHash("sha256").update(content).digest("hex")).toBe(data.hash);
    expect(content).not.toContain(secret);
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

  it("rejects schema-invalid plugin tool arguments with 422 naming the missing field", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const error = await gateway
      .executeTool({
        sessionToken: session.token,
        tool: "a.b:wiki_read_page",
        parameters: { wikiId: "main", path: "index.md" },
      })
      .then(
        () => {
          throw new Error("Expected the schema-invalid call to be rejected");
        },
        (caught) => caught as ToolGatewayHttpError,
      );
    expect(error).toBeInstanceOf(ToolGatewayHttpError);
    expect(error.status).toBe(422);
    expect(error.reasonCode).toBe("invalid_tool_arguments");
    expect(error.message).toContain("companyId");
    expect(error.details).toMatchObject({
      issues: [expect.objectContaining({ field: "companyId" })],
    });

    // Schema rejection happens before invocation recording: no failed call,
    // no audit noise for a client mistake.
    const invocations = await db.select().from(toolInvocations);
    expect(invocations).toEqual([]);
  });

  it("returns a flat plugin tool result envelope on tools/call", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const outcome = await gateway.executeTool({
      sessionToken: session.token,
      tool: "a.b:wiki_read_page",
      parameters: { companyId: company.id, wikiId: "main", path: "index.md" },
    });

    expect(outcome).toMatchObject({ status: "completed", tool: "a.b:wiki_read_page" });
    const result = outcome.result as Record<string, unknown>;
    // Documented wire contract: result.content / result.data directly — not
    // the dispatcher envelope nested under result.result.
    expect(result).toMatchObject({
      content: wikiReadPageContent,
      data: {
        hash: createHash("sha256").update(wikiReadPageContent).digest("hex"),
      },
    });
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("pluginId");
  });

  it("serves the tools/call HTTP route with the 422 and flat-result contract", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const app = express();
    app.use(express.json());
    app.use("/api", toolGatewayRoutes(db, gateway));

    const missingCompanyId = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", session.token)
      .send({ tool: "a.b:wiki_read_page", parameters: { wikiId: "main", path: "index.md" } });
    expect(missingCompanyId.status).toBe(422);
    expect(missingCompanyId.body).toMatchObject({
      error: expect.stringContaining("companyId"),
      reasonCode: "invalid_tool_arguments",
    });

    const valid = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", session.token)
      .send({
        tool: "a.b:wiki_read_page",
        parameters: { companyId: company.id, wikiId: "main", path: "index.md" },
      });
    expect(valid.status).toBe(200);
    expect(valid.body.result).toMatchObject({
      content: wikiReadPageContent,
      data: { hash: expect.any(String) },
    });
    expect(valid.body.result).not.toHaveProperty("result");
    expect(createHash("sha256").update(valid.body.result.content).digest("hex")).toBe(
      valid.body.result.data.hash,
    );
  });
});
