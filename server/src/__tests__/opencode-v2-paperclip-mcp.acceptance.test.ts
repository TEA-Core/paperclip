import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { OPENCODE_V2_CLI_VERSION } from "@paperclipai/adapter-opencode-local";
import { execute } from "@paperclipai/adapter-opencode-local/server";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

// Real OpenCode V2 binary + real adapter (private `opencode serve` transport) +
// the real Paperclip project-tools MCP route (`/api/mcp/project-tools`, real
// embedded Postgres, real agent JWT). Only the model is a local SSE fixture, so
// nothing is charged to a model provider.
// Asks one question: are the four Paperclip project tools in the FIRST
// main-agent request? The adapter's readiness gate is timer-based by necessity
// (https://github.com/anomalyco/opencode/issues/60893), so this is the check
// that catches the gate being too short. Opt-in like the adapter's own
// real-binary suite (`pnpm test:opencode-v2-acceptance`).
const enabled = process.env.PAPERCLIP_OPENCODE_V2_ACCEPTANCE === "1";
const support = enabled ? await getEmbeddedPostgresTestSupport() : { supported: false };
const PROJECT_TOOL_NAMES = ["create_project", "create_task", "list_project_repositories", "list_projects"];
const SERVER_NAME = "Paperclip projects";
const model = "paperclip-fixture/acceptance-model";

type ModelRequest = { at: number; toolNames: string[]; isTitle: boolean };

function provisionBinary(): string {
  const supplied = process.env.PAPERCLIP_OPENCODE_V2_BINARY?.trim();
  if (supplied) return supplied;
  const script = path.resolve(
    import.meta.dirname,
    "../../../packages/adapters/opencode-local/scripts/provision-opencode-v2-binary.mjs",
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 11 * 60_000 });
  const parsed = JSON.parse(`${result.stdout}`.trim().split("\n").at(-1) ?? "{}") as { binary?: string };
  if (result.status !== 0 || !parsed.binary || !existsSync(parsed.binary)) {
    throw new Error(`OpenCode V2 binary could not be provisioned: ${result.stderr}${result.stdout}`);
  }
  return parsed.binary;
}

(enabled && support.supported ? describe : describe.skip)("OpenCode V2 + real Paperclip MCP endpoint", () => {
  let api: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  let rootDir: string;
  let modelServer: Server;
  let modelPort: number;
  let binary: string;
  let requests: ModelRequest[] = [];
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;
  let savedAllowAll: string | undefined;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    savedAllowAll = process.env.OPENCODE_ALLOW_ALL_MODELS;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    binary = provisionBinary();
    api = await startRunnerApiTestServer();
    // The project-tools route calls back into the API for tool calls only.
    process.env.PAPERCLIP_API_URL = api.apiUrl;
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-v2-mcp-"));
    modelServer = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
      const toolNames = (parsed.tools ?? []).map((tool) => tool.function?.name ?? "");
      requests.push({ at: Date.now(), toolNames, isTitle: toolNames.length === 0 });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "fixture response" }, null));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    modelPort = (modelServer.address() as { port: number }).port;
  }, 12 * 60_000);

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    if (savedAllowAll !== undefined) process.env.OPENCODE_ALLOW_ALL_MODELS = savedAllowAll;
    await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
    await api?.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function runOnce(label: string) {
    requests = [];
    const f = await api.fixture();
    const home = path.join(rootDir, label);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string" && key !== "OPENCODE_ALLOW_ALL_MODELS") env[key] = value;
    }
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_DB: path.join(home, "data", "opencode.db"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    });
    const configDir = path.join(env.XDG_CONFIG_HOME, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        provider: {
          "paperclip-fixture": {
            npm: "@ai-sdk/openai-compatible",
            name: "Paperclip acceptance fixture",
            options: { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${modelPort}/v1` },
            models: { "acceptance-model": { name: "Paperclip acceptance model" } },
          },
        },
      }),
    );
    const workspace = path.join(rootDir, `${label}-workspace`);
    await mkdir(workspace, { recursive: true });
    const token = createLocalAgentJwt(f.agentId, f.companyId, "opencode_local", f.runId, null)!;
    const servers = [{
      name: SERVER_NAME,
      url: `${api.apiUrl}/api/mcp/project-tools`,
      token,
      connectionId: "paperclip-project-tools",
    }];
    const logs: string[] = [];
    const result = await execute({
      runId: f.runId,
      agent: { id: f.agentId, companyId: f.companyId, name: "mcp-lab", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: binary,
        cliVersion: OPENCODE_V2_CLI_VERSION,
        cwd: workspace,
        model,
        dangerouslySkipPermissions: true,
        env,
      },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      runtimeMcp: { getServers: () => servers },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    } as AdapterExecutionContext);
    const main = requests.filter((request) => !request.isTitle);
    return { result, requests: [...requests], main, logs: logs.join(""), token };
  }

  it("puts the four Paperclip project tools in the first main-agent request", async () => {
    const run = await runOnce("first-request");
    expect(run.result.exitCode, run.logs).toBe(0);
    expect(run.main.length).toBeGreaterThan(0);
    // OpenCode names MCP tools `<server>_<tool>` with the server name sanitized.
    const names = run.main[0]!.toolNames;
    for (const tool of PROJECT_TOOL_NAMES) {
      expect(names, `first main request tools: ${names.join(", ")}`).toContain(`Paperclip_projects_${tool}`);
    }
    expect(JSON.stringify({ result: run.result, logs: run.logs })).not.toContain(run.token);
  }, 120_000);
});
