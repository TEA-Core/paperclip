import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import {
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { OPENCODE_V2_CLI_VERSION } from "../index.js";
import { parseOpenCodeCliVersion } from "./version.js";

// Drives a real OpenCode V2 binary against a local OpenAI-compatible fixture.
// The binary is the platform package's own executable
// (`@opencode/cli-<platform>/bin/opencode`, referenced by absolute path because
// the `opencode` bin name collides with V1), provisioned by
// `../../scripts/provision-opencode-v2-binary.mjs` at the version
// `OPENCODE_V2_CLI_VERSION` pins. Every home, XDG dir and the database is
// private to the run, and every launch is `--standalone`, so the shared managed
// OpenCode service is never touched.
//
// Reproduce it from a clean checkout with one command — `pnpm
// test:opencode-v2-acceptance`, which is what the `OpenCode V2 acceptance`
// workflow runs. `PAPERCLIP_OPENCODE_V2_BINARY` overrides the provisioned
// binary; the default `pnpm test` run skips this file because it must neither
// fetch a ~250 MB binary nor launch real processes.
//
// Opting in without a usable binary fails the suite instead of skipping it, so
// an unenforced run cannot look like a passing one.
const enabled = process.env.PAPERCLIP_OPENCODE_V2_ACCEPTANCE === "1";
const suppliedBinary = process.env.PAPERCLIP_OPENCODE_V2_BINARY?.trim() ?? "";
// Provisioning fetches and unpacks the pinned release; the default 5s hook
// budget is far too small for a cold cache.
const PROVISION_BUDGET_MS = 11 * 60_000;

function provisionBinary(): string {
  const script = fileURLToPath(
    new URL("../../scripts/provision-opencode-v2-binary.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: PROVISION_BUDGET_MS,
  });
  const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
  if (result.error) throw new Error(`OpenCode V2 provisioning crashed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`OpenCode V2 acceptance binary could not be provisioned: ${detail}`);
  }
  const parsed = JSON.parse(detail.split("\n").at(-1) ?? "{}") as { binary?: unknown };
  if (typeof parsed.binary !== "string" || !existsSync(parsed.binary)) {
    throw new Error(`OpenCode V2 provisioning did not return a readable binary: ${detail}`);
  }
  return parsed.binary;
}
const model = "paperclip-fixture/acceptance-model";
// Prompt markers the fixture reacts to; they travel through `promptTemplate`.
const CANCEL_MARKER = "paperclip-acceptance-cancel";
const FORCE_LENGTH_MARKER = "paperclip-acceptance-force-length";

const execFileAsync = promisify(execFile);

const suite = describe.skipIf(!enabled)("OpenCode V2 real-binary acceptance", () => {
  let rootDir: string;
  let workspace: string;
  let server: Server;
  let baseEnv: Record<string, string>;
  let emptyCatalogEnv: Record<string, string>;
  let binary: string;
  let cliVersion: string;
  let savedAllowAllModels: string | undefined;

  function privateEnv(name: string): Record<string, string> {
    const home = path.join(rootDir, name);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // OPENCODE_ALLOW_ALL_MODELS makes the adapter skip model discovery. The
      // image exports it; this suite must exercise discovery, so it never
      // inherits it.
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

  async function writeOpenCodeConfig(env: Record<string, string>, config: Record<string, unknown>) {
    const dir = path.join(env.XDG_CONFIG_HOME as string, "opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "opencode.json"), `${JSON.stringify(config)}\n`);
  }

  beforeAll(async () => {
    binary = suppliedBinary;
    if (binary && !existsSync(binary)) {
      throw new Error(`PAPERCLIP_OPENCODE_V2_BINARY points at "${binary}", which is not readable.`);
    }
    if (!binary) binary = provisionBinary();

    // The adapter falls back to process.env when the run env omits the flag.
    savedAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;

    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-v2-acceptance-"));
    workspace = path.join(rootDir, "workspace");
    await mkdir(workspace, { recursive: true });

    const reported = await execFileAsync(binary, ["--version"], {
      env: privateEnv("version-probe"),
      timeout: 20_000,
    });
    const detected = parseOpenCodeCliVersion(`${reported.stdout}\n${reported.stderr}`);
    if (!detected) throw new Error(`Could not read a version from "${binary} --version".`);
    cliVersion = detected.version;

    server = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const lowered = body.toLowerCase();
      if (lowered.includes(CANCEL_MARKER)) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      // A prompt carrying the marker makes the model stop at its output cap
      // instead of a natural end of turn.
      const finishReason = lowered.includes(FORCE_LENGTH_MARKER) ? "length" : "stop";
      res.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-paperclip", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "fixture response" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-paperclip", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Acceptance fixture did not expose a TCP port.");

    // The provider lives in the user's opencode.json, not in a Paperclip-only
    // env var, so plain `opencode models` sees it too.
    baseEnv = privateEnv("main");
    await writeOpenCodeConfig(baseEnv, {
      provider: {
        "paperclip-fixture": {
          npm: "@ai-sdk/openai-compatible",
          name: "Paperclip acceptance fixture",
          options: { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${address.port}/v1` },
          models: { "acceptance-model": { name: "Paperclip acceptance model" } },
        },
      },
    });

    // Restricting OpenCode to a provider that does not exist yields a real,
    // exit-0, empty `opencode models` catalog.
    emptyCatalogEnv = privateEnv("empty-catalog");
    await writeOpenCodeConfig(emptyCatalogEnv, { enabled_providers: ["paperclip-no-such-provider"] });
  }, PROVISION_BUDGET_MS);

  afterAll(async () => {
    if (savedAllowAllModels === undefined) delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    else process.env.OPENCODE_ALLOW_ALL_MODELS = savedAllowAllModels;
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
        cliVersion,
        cwd: workspace,
        model,
        dangerouslySkipPermissions: true,
        env: baseEnv,
      },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      onLog: async () => {},
      ...overrides,
    } as AdapterExecutionContext;
  }

  it("runs a binary version the adapter supports and never inherits the model-discovery bypass", async () => {
    expect(cliVersion).toBe(OPENCODE_V2_CLI_VERSION);
    expect(process.env.OPENCODE_ALLOW_ALL_MODELS).toBeUndefined();
    expect(baseEnv.OPENCODE_ALLOW_ALL_MODELS).toBeUndefined();
    const result = await testEnvironment({
      companyId: "acceptance-company",
      adapterType: "opencode_local",
      config: {
        command: binary,
        cliVersion,
        cwd: workspace,
        env: baseEnv,
      },
    } as AdapterEnvironmentTestContext);
    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "opencode_command_resolvable" }),
    ]));
  });

  it("discovers a non-empty real catalog that contains the configured model", async () => {
    resetOpenCodeModelsCacheForTests();
    const discovered = await discoverOpenCodeModels({
      cliVersion,
      command: binary,
      cwd: workspace,
      env: baseEnv,
    });
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered.map((entry) => entry.id)).toContain(model);

    const available = await ensureOpenCodeModelConfiguredAndAvailable({
      cliVersion,
      command: binary,
      cwd: workspace,
      env: baseEnv,
      model,
    });
    expect(available.map((entry) => entry.id)).toContain(model);
    expect(available.length).toBeGreaterThan(1);
  });

  it("rejects a configured model that the real catalog does not list", async () => {
    resetOpenCodeModelsCacheForTests();
    await expect(ensureOpenCodeModelConfiguredAndAvailable({
      cliVersion,
      command: binary,
      cwd: workspace,
      env: baseEnv,
      model: "paperclip-fixture/not-in-catalog",
    })).rejects.toThrow("Configured OpenCode model is unavailable: paperclip-fixture/not-in-catalog");
  }, 60_000);

  it("throws on an empty real catalog instead of passing the model through", async () => {
    resetOpenCodeModelsCacheForTests();
    await expect(discoverOpenCodeModels({
      cliVersion,
      command: binary,
      cwd: workspace,
      env: emptyCatalogEnv,
    })).resolves.toEqual([]);
    await expect(ensureOpenCodeModelConfiguredAndAvailable({
      cliVersion,
      command: binary,
      cwd: workspace,
      env: emptyCatalogEnv,
      model,
    })).rejects.toThrow(`OpenCode V2 model discovery returned no models for "${model}".`);
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

  it("reports a forced output cap as a failure, not as an exit-0 success", async () => {
    const result = await execute(context({
      runId: "acceptance-length",
      config: {
        command: binary,
        cliVersion,
        cwd: workspace,
        model,
        dangerouslySkipPermissions: true,
        promptTemplate: `${FORCE_LENGTH_MARKER}: answer until you hit the output cap`,
        env: baseEnv,
      },
    }));
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.finishReason).toBe("length");
    expect(result.errorMessage).toEqual(expect.stringMatching(/output token limit|output-token cap/i));
    // OpenCode 2.2.3+ names the cap itself, so the failure is not only the
    // adapter's own reading of a `length` finish reason.
    const stdout = String(result.resultJson?.stdout ?? "");
    expect(stdout).toContain("output-limit");
    expect(stdout).toContain('"type":"error"');
  }, 90_000);

  it("rejects an invalid model before launching the real binary", async () => {
    await expect(execute(context({
      runId: "acceptance-invalid-model",
      config: {
        command: binary,
        cliVersion,
        cwd: workspace,
        model: "invalid-model",
        env: baseEnv,
      },
    }))).rejects.toThrow("provider/model format");
  });

  it("cancels a slow real run through the adapter timeout", async () => {
    const result = await execute(context({
      runId: "acceptance-cancel",
      config: {
        command: binary,
        cliVersion,
        cwd: workspace,
        model,
        timeoutSec: 1,
        graceSec: 1,
        dangerouslySkipPermissions: true,
        promptTemplate: `${CANCEL_MARKER}: this request never finishes`,
        env: baseEnv,
      },
    }));
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  }, 30_000);
});

void suite;
