import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOpenCodeServeArgs } from "./serve-transport.js";
import {
  OpenCodeMcpReadinessError,
  waitForOpenCodeMcpReady,
} from "./mcp-readiness-gate.js";

// SUP-22282 (SUP-19139 A1 probe): proves the readiness gate module against the
// pinned real OpenCode V2 binary in serve mode, over the raw server API — the
// path the SUP-19139 readiness spike validated (`readiness-signal-report`).
// After `waitForOpenCodeMcpReady` passes, one `POST /api/session` +
// `POST /api/session/{id}/prompt` must put the remote MCP server's tools in
// the FIRST main-agent provider request; an unreachable MCP server must
// hard-fail the gate at its deadline so no session is ever created.
//
// The MCP server under test is a local Streamable HTTP fixture exposing the
// same tool names the Paperclip runtime-tools MCP server exposes. The real
// runtime-tools endpoint cannot serve spawned test processes: it is bound to
// the live task run and answers MCP initialize from a fresh process with
// `422 Connection requests require a task-bound heartbeat run` (observed
// 2026-11-01; the same bearer worked from inside the live run minutes
// earlier). The real endpoint's half of the contract was validated by the
// spike (connected + paperclip_* tools in the first request, 5/5); this suite
// proves the gate binary-invariant — the SSE/status/quiescence contract is
// endpoint-agnostic, and CI has no runtime-tools endpoint to call anyway.
//
// Opt-in like the adapter's other real-binary suites; opting in without a
// usable binary fails the suite instead of skipping it.
const enabled = process.env.PAPERCLIP_OPENCODE_V2_ACCEPTANCE === "1";
const suppliedBinary = process.env.PAPERCLIP_OPENCODE_V2_BINARY?.trim() ?? "";
const PROVISION_BUDGET_MS = 11 * 60_000;
const MCP_SERVER_NAME = "paperclip";
// The runtime-tools server exposes exactly these; OpenCode names MCP tools
// `<sanitized server>_<tool>`, so the fixture's tools land as
// `paperclip_connection_request` / `paperclip_connections_search`.
const EXPECTED_TOOLS = ["connection_request", "connections_search"];
const MODEL = "paperclip-fixture/acceptance-model";
const PROVIDER_ID = "paperclip-fixture";
const MODEL_ID = "acceptance-model";
const SERVER_USERNAME = "opencode";
const MCP_FIXTURE_BEARER = "gate-fixture-bearer";

interface ModelRequest {
  url?: string;
  status?: number;
  tools: string[];
  isMain: boolean;
}

function provisionBinary(): string {
  const script = path.resolve(
    import.meta.dirname,
    "../../scripts/provision-opencode-v2-binary.mjs",
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: PROVISION_BUDGET_MS });
  const parsed = JSON.parse(`${result.stdout}`.trim().split("\n").at(-1) ?? "{}") as { binary?: string };
  if (result.status !== 0 || !parsed.binary || !existsSync(parsed.binary)) {
    throw new Error(`OpenCode V2 binary could not be provisioned: ${result.stderr}${result.stdout}`);
  }
  return parsed.binary;
}

const suite = describe.skipIf(!enabled)("OpenCode V2 MCP readiness gate (real binary, server API)", () => {
  let binary: string;
  let rootDir: string;
  let modelServer: Server;
  let modelPort: number;
  let modelRequests: ModelRequest[];
  let mcpFixture: Server;
  let mcpUrl: string;
  // Every serve process this suite started, for afterAll teardown.
  const serveProcesses: Array<{ kill: () => Promise<void> }> = [];
  let savedAllowAll: string | undefined;

  beforeAll(async () => {
    binary = suppliedBinary && existsSync(suppliedBinary) ? suppliedBinary : provisionBinary();
    savedAllowAll = process.env.OPENCODE_ALLOW_ALL_MODELS;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-gate-"));

    // Every request the fixture model server sees, including 404s, so a
    // failure prints what OpenCode actually asked for.
    modelRequests = [];
    modelServer = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") {
        modelRequests.push({ url: req.url, status: 404, tools: [], isMain: false });
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let tools: string[] = [];
      try {
        const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
        tools = (parsed.tools ?? []).map((tool) => tool.function?.name ?? "");
      } catch {
        // not a JSON chat request
      }
      // A main-agent request carries tools; a title request carries none.
      modelRequests.push({ tools, isMain: tools.length > 0 });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "fixture response" }, null));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    modelPort = (modelServer.address() as { port: number }).port;

    // Local Streamable HTTP MCP fixture answering the methods a real remote
    // server does, exposing the runtime-tools tool names.
    mcpFixture = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.method !== "POST") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const message = JSON.parse(raw) as { id?: unknown; method?: string };
      if (message.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result }));
      };
      if (message.method === "initialize") {
        reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "gate-fixture", version: "1" } });
      } else if (message.method === "tools/list") {
        reply({
          tools: EXPECTED_TOOLS.map((name) => ({
            name,
            description: `Fixture ${name}.`,
            inputSchema: { type: "object", properties: {} },
          })),
        });
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Method not found" } }));
      }
    });
    await new Promise<void>((resolve) => mcpFixture.listen(0, "127.0.0.1", resolve));
    const mcpPort = (mcpFixture.address() as { port: number }).port;
    mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  }, PROVISION_BUDGET_MS);

  afterAll(async () => {
    if (savedAllowAll !== undefined) process.env.OPENCODE_ALLOW_ALL_MODELS = savedAllowAll;
    for (const proc of serveProcesses.reverse()) await proc.kill();
    // OpenCode's HTTP client holds keep-alive sockets; close() alone would
    // wait on them forever.
    modelServer?.closeAllConnections?.();
    await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
    mcpFixture?.closeAllConnections?.();
    await new Promise<void>((resolve) => mcpFixture?.close(() => resolve()));
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  }, 30_000);

  function isolatedEnv(label: string): Record<string, string> {
    const home = path.join(rootDir, label);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string" && key !== "OPENCODE_ALLOW_ALL_MODELS") env[key] = value;
    }
    return {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_DB: path.join(home, "data", "opencode.db"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
  }

  async function writeServeConfig(
    env: Record<string, string>,
    serverUrl: string,
  ): Promise<void> {
    const dir = path.join(env.XDG_CONFIG_HOME as string, "opencode");
    await mkdir(dir, { recursive: true });
    // The `mcp` block shape is the one the readiness spike validated against
    // this exact binary: `enabled: true` + `codemode: false` + Bearer header.
    await writeFile(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        provider: {
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Paperclip acceptance fixture",
            options: { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${modelPort}/v1` },
            models: { [MODEL_ID]: { name: "Paperclip acceptance model" } },
          },
        },
        mcp: {
          servers: {
            [MCP_SERVER_NAME]: {
              type: "remote",
              url: serverUrl,
              enabled: true,
              codemode: false,
              headers: { Authorization: `Bearer ${MCP_FIXTURE_BEARER}` },
            },
          },
        },
      }),
    );
  }

  /** Starts a private serve; resolves its base URL and Basic auth credential. */
  async function startServe(label: string, serverUrl: string) {
    const env = isolatedEnv(label);
    await writeServeConfig(env, serverUrl);
    const workspace = path.join(rootDir, `${label}-workspace`);
    await mkdir(workspace, { recursive: true });
    const password = randomBytes(24).toString("hex");
    const credential = Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64");
    const child = spawn(binary, buildOpenCodeServeArgs(), {
      cwd: workspace,
      env: { ...env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let port: number | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (port === null) port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1] ?? 0) || null;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (port === null) port = Number(/listening on http:\/\/127\.0.0\.1:(\d+)/.exec(output)?.[1] ?? 0) || null;
    });
    const startedAt = Date.now();
    while (port === null && child.exitCode === null && Date.now() - startedAt < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (port === null) {
      child.kill("SIGKILL");
      throw new Error(`OpenCode serve did not report a listening port: ${output.slice(0, 500)}`);
    }
    serveProcesses.push({
      kill: async () => {
        if (child.exitCode !== null) return;
        // Register the waiter before signaling: the exit event may fire while
        // the grace loop below is polling, and a waiter attached afterwards
        // would never resolve.
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const grace = Date.now() + 5_000;
        while (child.exitCode === null && Date.now() < grace) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
      },
    });
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      authorization: `Basic ${credential}`,
      request: async (pathName: string, init: RequestInit = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
          ...init,
          headers: { Authorization: `Basic ${credential}`, "content-type": "application/json" },
        });
        return { status: response.status, text: await response.text() };
      },
    };
  }

  it("puts the gate's MCP tools in the first main-agent request after the gate passes", async () => {
    modelRequests = [];
    const serve = await startServe("gate-positive", mcpUrl);
    const diagnostics: string[] = [];
    const gate = await waitForOpenCodeMcpReady({
      baseUrl: serve.baseUrl,
      authorization: serve.authorization,
      servers: [MCP_SERVER_NAME],
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(gate.statuses[MCP_SERVER_NAME]).toBe("connected");

    const created = await serve.request("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "paperclip",
        model: { providerID: PROVIDER_ID, id: MODEL_ID },
      }),
    });
    expect(created.status, created.text.slice(0, 300)).toBe(200);
    const sessionId = (JSON.parse(created.text) as { data?: { id?: string } }).data?.id;
    expect(sessionId).toEqual(expect.any(String));

    const prompted = await serve.request(`/api/session/${encodeURIComponent(sessionId as string)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        providerID: PROVIDER_ID,
        modelID: MODEL_ID,
        text: "Reply with a single word: ok",
      }),
    });
    expect(prompted.status, prompted.text.slice(0, 300)).toBe(200);

    for (let i = 0; i < 200 && modelRequests.filter((request) => request.isMain).length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const main = modelRequests.filter((request) => request.isMain);
    expect(main.length, `model requests: ${JSON.stringify(modelRequests)}`).toBeGreaterThan(0);
    for (const request of main) {
      for (const tool of EXPECTED_TOOLS) {
        expect(request.tools, `main-agent request tools: ${request.tools.join(", ")}`).toContain(`${MCP_SERVER_NAME}_${tool}`);
      }
    }
    // The gate observed the real transition, not just an instant pass.
    expect(diagnostics.some((message) => message.startsWith("mcp event:"))).toBe(true);
  }, 120_000);

  it("hard-fails the gate at its deadline on an unreachable MCP server and never prompts (readiness4 neg1)", async () => {
    modelRequests = [];
    // Port 9 (discard) on loopback: connection refused, nothing listens.
    const serve = await startServe("gate-negative", "http://127.0.0.1:9/mcp");
    const failure = await waitForOpenCodeMcpReady({
      baseUrl: serve.baseUrl,
      authorization: serve.authorization,
      servers: [MCP_SERVER_NAME],
      deadlineMs: 2_000,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(OpenCodeMcpReadinessError);
    const error = failure as OpenCodeMcpReadinessError;
    expect(error.reason).toBe("deadline");
    expect(error.message).toContain("do not create a session");
    expect(error.message).toContain(MCP_SERVER_NAME);
    // The gate contract in force: no session, no prompt, no provider request.
    expect(modelRequests).toEqual([]);
  }, 60_000);
});

void suite;
