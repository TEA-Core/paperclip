import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
import {
  createOpenCodeV2SessionByteMeasurer,
  readOpenCodeV2SessionState,
  resolveOpenCodeDatabasePath,
  startOpenCodeDatabaseGrowthGuard,
  type OpenCodeDatabaseGrowthSpare,
  type OpenCodeDatabaseGrowthTrip,
} from "./db-guard.js";
import { execute, resolveOpenCodeDatabaseFile } from "./execute.js";
import { testEnvironment } from "./test.js";
import { OPENCODE_V2_CLI_VERSION } from "../index.js";
import { parseOpenCodeCliVersion } from "./version.js";

// Drives a real OpenCode V2 binary against a local OpenAI-compatible fixture.
// The binary is the platform package's own executable
// (`@opencode/cli-<platform>/bin/opencode`, referenced by absolute path because
// the `opencode` bin name collides with V1), provisioned by
// `../../scripts/provision-opencode-v2-binary.mjs` at the version
// `OPENCODE_V2_CLI_VERSION` pins. Every home, XDG dir and the database is
// private to the run, and the adapter drives a private loopback `opencode serve`
// (per-run port and password) for local V2 runs, so the shared managed OpenCode
// service is never touched.
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
  let guardEnv: Record<string, string>;
  let emptyCatalogEnv: Record<string, string>;
  let binary: string;
  let cliVersion: string;
  let savedAllowAllModels: string | undefined;
  // Every request that carried tools, i.e. a main-agent request (title requests carry none).
  const mainRequests: Array<{ tools: string[]; messageCount: number }> = [];
  let mcpServer: Server;

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
      try {
        const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }>; messages?: unknown[] };
        if ((parsed.tools ?? []).length > 0) {
          mainRequests.push({
            tools: (parsed.tools ?? []).map((tool) => tool.function?.name ?? ""),
            messageCount: (parsed.messages ?? []).length,
          });
        }
      } catch {
        // not a JSON chat request
      }
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

    // A Streamable HTTP MCP server that lists one tool, the shape of the
    // Paperclip project-tools route.
    mcpServer = createServer(async (req, res) => {
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
        reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "fixture", version: "1" } });
      } else if (message.method === "tools/list") {
        reply({ tools: [{ name: "echo", description: "Echo a value.", inputSchema: { type: "object", properties: {} } }] });
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Method not found" } }));
      }
    });
    await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));

    // The provider lives in the user's opencode.json, not in a Paperclip-only
    // env var, so plain `opencode models` sees it too.
    const fixtureConfig = {
      provider: {
        "paperclip-fixture": {
          npm: "@ai-sdk/openai-compatible",
          name: "Paperclip acceptance fixture",
          options: { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${address.port}/v1` },
          models: { "acceptance-model": { name: "Paperclip acceptance model" } },
        },
      },
    };
    baseEnv = privateEnv("main");
    await writeOpenCodeConfig(baseEnv, fixtureConfig);

    // The session guards only arm on the per-agent database the adapter names
    // itself, which it does only when no OPENCODE_DB is configured.
    guardEnv = privateEnv("guard");
    delete guardEnv.OPENCODE_DB;
    // privateEnv copies the runner's environment; its PWD would root every session
    // at the runner's directory instead of the workspace the run is spawned in.
    delete guardEnv.PWD;
    await writeOpenCodeConfig(guardEnv, fixtureConfig);

    // Restricting OpenCode to a provider that does not exist yields a real,
    // exit-0, empty `opencode models` catalog.
    emptyCatalogEnv = privateEnv("empty-catalog");
    await writeOpenCodeConfig(emptyCatalogEnv, { enabled_providers: ["paperclip-no-such-provider"] });
  }, PROVISION_BUDGET_MS);

  afterAll(async () => {
    if (savedAllowAllModels === undefined) delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    else process.env.OPENCODE_ALLOW_ALL_MODELS = savedAllowAllModels;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await new Promise<void>((resolve) => mcpServer?.close(() => resolve()));
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
    expect(commandArgs[0]).toEqual(expect.arrayContaining(["serve", `<resume session ${first.sessionId as string}>`]));
    // Same session, and the model saw the first run's turn: the second main
    // request carries strictly more messages than the first.
    expect(second.sessionId).toBe(first.sessionId);
    expect(mainRequests.length).toBeGreaterThanOrEqual(2);
    expect(mainRequests.at(-1)!.messageCount).toBeGreaterThan(mainRequests[0]!.messageCount);
  }, 90_000);

  // SUP-19141: the session guards read the database this very binary wrote, not
  // a hand-built schema, so a column or table the pinned build changes fails here.
  async function runSession(
    runId: string,
    options: { sessionId?: string | null; sessionParams?: Record<string, unknown> | null; env?: Record<string, string> } = {},
  ) {
    const logs: string[] = [];
    const commandArgs: string[][] = [];
    const result = await execute(context({
      runId,
      runtime: {
        sessionId: options.sessionId ?? null,
        sessionParams: options.sessionParams ?? null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: binary,
        cliVersion,
        cwd: workspace,
        model,
        dangerouslySkipPermissions: true,
        env: { ...guardEnv, ...(options.env ?? {}) },
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async (meta) => {
        commandArgs.push((meta.commandArgs ?? []).filter((arg): arg is string => typeof arg === "string"));
      },
    }));
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toEqual(expect.any(String));
    return { result, sessionId: result.sessionId as string, log: logs.join(""), args: commandArgs[0] ?? [] };
  }

  function guardDatabasePath(): string {
    const file = resolveOpenCodeDatabaseFile({ agentId: "acceptance-agent", env: guardEnv });
    const resolved = file ? resolveOpenCodeDatabasePath({ databaseFile: file, env: guardEnv }) : null;
    if (!resolved) throw new Error("The adapter did not name a per-agent database for the guard environment.");
    return resolved;
  }

  async function openDatabase(readOnly: boolean) {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(guardDatabasePath(), { readOnly });
  }

  // Grow one session's transcript by `bytes` through the real session_message table.
  async function padSession(sessionId: string, bytes: number) {
    const db = await openDatabase(false);
    try {
      const next = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_message WHERE session_id = ?").get(sessionId);
      const now = Date.now();
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', ?, ?, ?, ?)",
      ).run(`pad_${sessionId}_${now}`, sessionId, Number(next?.seq), now, now, JSON.stringify({ text: "x".repeat(bytes) }));
    } finally {
      db.close();
    }
  }

  it("reads existence, directory, size and final message from a database the binary wrote", async () => {
    const { sessionId } = await runSession("acceptance-state");
    const dbPath = guardDatabasePath();
    const read = await readOpenCodeV2SessionState(dbPath, sessionId);
    if (!read.ok) throw new Error(`probe failed against the real database: ${read.error}`);
    expect(read.state.exists).toBe(true);
    expect(await realpath(read.state.cwd as string)).toBe(await realpath(workspace));
    expect(read.state.messageCount).toBeGreaterThanOrEqual(2);
    expect(read.state.transcriptBytes).toBeGreaterThan(0);
    expect(read.state.finalMessage).toBe("fixture response");

    const db = await openDatabase(true);
    try {
      const raw = db.prepare("SELECT SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM session_message WHERE session_id = ?").get(sessionId);
      expect(read.state.transcriptBytes).toBe(Number(raw?.bytes));
    } finally {
      db.close();
    }

    const absent = await readOpenCodeV2SessionState(dbPath, "ses_does_not_exist");
    expect(absent).toEqual({
      ok: true,
      state: { exists: false, cwd: null, messageCount: 0, transcriptBytes: 0, finalMessage: null },
    });
  }, 90_000);

  it("keeps size and existence but returns no final message when the newest assistant row is oversized", async () => {
    const { sessionId } = await runSession("acceptance-final-bound");
    const dbPath = guardDatabasePath();
    const before = await readOpenCodeV2SessionState(dbPath, sessionId);
    if (!before.ok) throw new Error(`probe failed against the real database: ${before.error}`);
    expect(before.state.finalMessage).toBe("fixture response");

    const db = await openDatabase(false);
    let addedBytes: number;
    try {
      const row = db
        .prepare(
          "SELECT id, data FROM session_message WHERE session_id = ? AND type = 'assistant' " +
            "AND json_extract(data, '$.time.completed') IS NOT NULL ORDER BY seq DESC LIMIT 1",
        )
        .get(sessionId);
      if (!row) throw new Error("The real session has no completed assistant row to enlarge.");
      const original = String(row.data);
      const enlarged = JSON.stringify({
        ...JSON.parse(original),
        content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
      });
      db.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(enlarged, row.id);
      addedBytes = Buffer.byteLength(enlarged) - Buffer.byteLength(original);
    } finally {
      db.close();
    }

    const after = await readOpenCodeV2SessionState(dbPath, sessionId);
    if (!after.ok) throw new Error(`probe failed against the enlarged database: ${after.error}`);
    expect(after.state.exists).toBe(true);
    expect(after.state.messageCount).toBe(before.state.messageCount);
    expect(after.state.transcriptBytes).toBe(before.state.transcriptBytes + addedBytes);
    expect(after.state.finalMessage).toBeNull();
  }, 90_000);

  it("reports an unreadable or non-V2 database as an error instead of a measurement", async () => {
    const missing = await readOpenCodeV2SessionState(path.join(rootDir, "no-such.db"), "ses_x");
    expect(missing.ok).toBe(false);
    const { DatabaseSync } = await import("node:sqlite");
    const v1Shaped = path.join(rootDir, "v1-shaped.db");
    const db = new DatabaseSync(v1Shaped);
    db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)");
    db.close();
    const nonV2 = await readOpenCodeV2SessionState(v1Shaped, "ses_x");
    expect(nonV2.ok).toBe(false);
    if (!nonV2.ok) expect(nonV2.error).toMatch(/session_v2/);

    const unavailable: string[] = [];
    const measure = createOpenCodeV2SessionByteMeasurer((message) => unavailable.push(message));
    expect(await measure(v1Shaped, "ses_x")).toBeNull();
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toContain("ses_x");
  });

  it("resumes from the recorded session directory and starts fresh for a session the database lacks", async () => {
    const { sessionId } = await runSession("acceptance-dbcwd");
    // No cwd in the saved params: a V1 session would be refused as unknown_cwd,
    // but V2 proves the directory from session_v2.
    const resumed = await runSession("acceptance-dbcwd-resume", { sessionId });
    expect(resumed.args).toEqual(expect.arrayContaining(["--session", sessionId]));

    const missing = await runSession("acceptance-missing", {
      sessionId: "ses_not_in_this_database",
      sessionParams: { sessionId: "ses_not_in_this_database", cwd: workspace },
    });
    expect(missing.args).not.toContain("--session");
    expect(missing.log).toContain("is absent from its database");
  }, 120_000);

  it("starts a fresh session when the real transcript exceeds the resume cap", async () => {
    const { sessionId } = await runSession("acceptance-cap-seed");
    const capped = await runSession("acceptance-cap", {
      sessionId,
      env: { PAPERCLIP_OPENCODE_SESSION_MAX_BYTES: "1" },
    });
    expect(capped.args).not.toContain("--session");
    expect(capped.log).toContain("resume cap");
    expect(capped.sessionId).not.toBe(sessionId);

    const uncapped = await runSession("acceptance-cap-off", { sessionId });
    expect(uncapped.args).toEqual(expect.arrayContaining(["--session", sessionId]));
  }, 120_000);

  it("attributes growth to the run's own session and spares it for a sibling's growth", async () => {
    const own = (await runSession("acceptance-own")).sessionId;
    const sibling = (await runSession("acceptance-sibling")).sessionId;
    expect(sibling).not.toBe(own);
    const limitBytes = 200_000;
    const spares: OpenCodeDatabaseGrowthSpare[] = [];
    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const unavailable: string[] = [];
    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath: guardDatabasePath(),
      limitBytes,
      pollIntervalMs: 50,
      sessionId: own,
      measureSessionBytes: createOpenCodeV2SessionByteMeasurer((message) => unavailable.push(message)),
      onSpare: (spare) => spares.push(spare),
      onTrip: (trip) => trips.push(trip),
    });
    try {
      // The guard polls a real file on a real interval; fake timers cannot drive
      // SQLite I/O, so this waits on the observed condition, bounded at 10s.
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        expect(done()).toBe(true);
      };
      // Let the guard take its baseline before anything grows.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await padSession(sibling, limitBytes * 2);
      await until(() => spares.length > 0);
      expect(trips).toHaveLength(0);
      expect(spares[0]?.attribution.sessionId).toBe(own);
      expect(spares[0]?.attribution.growthBytes).toBe(0);

      await padSession(own, limitBytes * 2);
      await until(() => trips.length > 0);
      expect(trips[0]?.attribution?.sessionId).toBe(own);
      expect(trips[0]?.attribution?.growthBytes).toBeGreaterThanOrEqual(limitBytes * 2);
      expect(unavailable).toEqual([]);
    } finally {
      guard.stop();
    }
  }, 120_000);

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

  it("puts an injected MCP server's tool in the first main-agent request", async () => {
    mainRequests.length = 0;
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("MCP fixture did not expose a TCP port.");
    const result = await execute(context({
      runId: "acceptance-mcp",
      runtimeMcp: {
        getServers: () => [{
          name: "paperclip-fixture",
          url: `http://127.0.0.1:${address.port}/mcp`,
          token: "acceptance-mcp-bearer",
          connectionId: "acceptance-connection",
        }],
      },
    }));
    expect(result.exitCode).toBe(0);
    expect(mainRequests.length).toBeGreaterThan(0);
    expect(mainRequests[0]!.tools.some((name) => /paperclip-fixture_echo$/i.test(name))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("acceptance-mcp-bearer");
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
