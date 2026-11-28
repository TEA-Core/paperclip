import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

const STRICT_INPUT_TOOLS = new Set(["paperclipCreateIssue", "paperclipUpdateIssue"]);

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    // Issue create/update register the full strict object so the SDK refuses
    // unknown top-level fields (e.g. monitorNextCheckAt) instead of stripping
    // them. Tools with an output schema register the full object too. Other
    // tools keep the shape, which ignores stray keys.
    const inputSchema =
      STRICT_INPUT_TOOLS.has(tool.name) || tool.outputSchema ? tool.schema : tool.schema.shape;
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    }, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
