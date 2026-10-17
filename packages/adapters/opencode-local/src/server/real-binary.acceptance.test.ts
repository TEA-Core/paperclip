import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import {
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  OPENCODE_V2_CLI_VERSION,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const enabled = process.env.PAPERCLIP_OPENCODE_V2_ACCEPTANCE === "1";
const binary = process.env.PAPERCLIP_OPENCODE_V2_BINARY?.trim() ?? "";
const model = "openai/gpt-4o-mini";

const suite = describe.skipIf(!enabled || !binary)("OpenCode V2 real-binary acceptance", () => {
  let rootDir: string;
  let configHome: string;
  let dataHome: string;
  let workspace: string;
  let server: Server;
  let baseEnv: Record<string, string>;
  let port: number;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-v2-acceptance-"));
    configHome = path.join(rootDir, "config");
    dataHome = path.join(rootDir, "data");
    workspace = path.join(rootDir, "workspace");
    await mkdir(path.join(configHome, "opencode"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    server = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      if (body.toLowerCase().includes("cancel")) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      res.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-paperclip", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "fixture response" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-paperclip", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Acceptance fixture did not expose a TCP port.");
    port = address.port;
    baseEnv = {
      ...process.env,
      HOME: rootDir,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: path.join(rootDir, "cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENAI_API_KEY: "fixture-key",
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        openai: {
          npm: "@ai-sdk/openai-compatible",
          name: "Paperclip acceptance fixture",
          options: { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${port}/v1` },
          models: { "gpt-4o-mini": { name: "Paperclip acceptance model" } },
        },
      }),
    };
    await writeFile(
      path.join(configHome, "opencode", "opencode.json"),
      `${JSON.stringify({ permission: { external_directory: "allow" } })}\n`,
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(rootDir, { recursive: true, force: true });
  });

  function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "acceptance-run",
      agent: {
        id: "acceptance-agent",
        companyId: "acceptance-company",
        name: "OpenCode acceptance",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: binary,
        cliVersion: OPENCODE_V2_CLI_VERSION,
        cwd: workspace,
        model,
        dangerouslySkipPermissions: true,
        env: { ...baseEnv, OPENCODE_ALLOW_ALL_MODELS: "1" },
      },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      onLog: async () => {},
      ...overrides,
    } as AdapterExecutionContext;
  }

  it("validates the pinned CLI version and runs the environment check", async () => {
    const result = await testEnvironment({
      companyId: "acceptance-company",
      adapterType: "opencode_local",
      config: {
        command: binary,
        cliVersion: OPENCODE_V2_CLI_VERSION,
        cwd: workspace,
        env: baseEnv,
      },
    } as AdapterEnvironmentTestContext);
    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "opencode_command_resolvable" }),
    ]));
  });

  it("discovers and validates a real V2 model catalog", async () => {
    resetOpenCodeModelsCacheForTests();
    const discovered = await discoverOpenCodeModels({
      cliVersion: OPENCODE_V2_CLI_VERSION,
      command: binary,
      cwd: workspace,
      env: baseEnv,
    });
    expect(discovered).toEqual([]);
    await expect(ensureOpenCodeModelConfiguredAndAvailable({
      cliVersion: OPENCODE_V2_CLI_VERSION,
      command: binary,
      cwd: workspace,
      env: baseEnv,
      model,
    })).resolves.toEqual([{ id: model, label: model }]);
  });

  it("executes a real V2 run and resumes its session", async () => {
    const first = await execute(context({ runId: "acceptance-first" }));
    expect(first.exitCode).toBe(0);
    expect(first.errorMessage).toBeNull();
    expect(first.sessionId).toEqual(expect.any(String));
    const commandArgs: string[][] = [];
    const second = await execute(context({
      runId: "acceptance-resume",
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: null,
      },
      onMeta: async (meta) => {
        commandArgs.push((meta.commandArgs ?? []).filter((arg): arg is string => typeof arg === "string"));
      },
    }));
    expect(second.exitCode).toBe(0);
    expect(second.errorMessage).toBeNull();
    expect(commandArgs[0]).toEqual(expect.arrayContaining(["--standalone", "--session", first.sessionId as string]));
  }, 90_000);

  it("rejects an invalid model before launching the real binary", async () => {
    await expect(execute(context({
      runId: "acceptance-invalid-model",
      config: {
        command: binary,
        cliVersion: OPENCODE_V2_CLI_VERSION,
        cwd: workspace,
        model: "invalid-model",
        env: { ...baseEnv, OPENCODE_ALLOW_ALL_MODELS: "1" },
      },
    }))).rejects.toThrow("provider/model format");
  });

  it("cancels a slow real run through the adapter timeout", async () => {
    const result = await execute(context({
      runId: "acceptance-cancel",
      config: {
        command: binary,
        cliVersion: OPENCODE_V2_CLI_VERSION,
        cwd: workspace,
        model,
        timeoutSec: 1,
        graceSec: 1,
        dangerouslySkipPermissions: true,
        env: { ...baseEnv, OPENCODE_ALLOW_ALL_MODELS: "1" },
      },
      context: {
        paperclipWorkspace: { cwd: workspace, source: "project_primary" },
        paperclipTaskMarkdown: "cancel this request",
      },
    }));
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  }, 30_000);
});

void suite;
