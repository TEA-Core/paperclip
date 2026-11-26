import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperclipMcpServer } from "./index.js";

async function withClient(run: (client: Client) => Promise<void>) {
  const { server } = createPaperclipMcpServer({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
  const client = new Client({ name: "registration-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("paperclip MCP server registration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("lets a tool outside issue create/update accept and ignore a stray key", async () => {
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL", "http://localhost:3100/runtime/connections/search");
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_TOKEN", "runtime-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await withClient(async (client) => {
      const result = await client.callTool({
        name: "connections_search",
        arguments: { query: "github", strayKey: "ignored" },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ query: "github" });
  });

  it.each(["paperclipCreateIssue", "paperclipUpdateIssue"])("%s refuses a stray top-level key before any request", async (name) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await withClient(async (client) => {
      const result = await client.callTool({
        name,
        arguments: {
          ...(name === "paperclipUpdateIssue" ? { issueId: "PAP-1" } : {}),
          title: "Monitor",
          monitorNextCheckAt: "2099-12-01T12:00:00.000Z",
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("monitorNextCheckAt");
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
