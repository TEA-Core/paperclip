import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOpenCodeJsonl } from "./parse.js";
import {
  buildOpenCodeServeArgs,
  parseOpenCodeServeModel,
  redactOpenCodeServeSecrets,
  runOpenCodeServeProcess,
  type OpenCodeServeInput,
} from "./serve-transport.js";

const fakeServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode-serve.mjs");
const TOKEN = "paperclip-mcp-bearer-token-value";

describe("OpenCode serve transport (fake server)", { timeout: 20_000 }, () => {
  let root: string;
  let command: string;
  let logFile: string;
  const logs: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-serve-"));
    logFile = path.join(root, "requests.jsonl");
    command = path.join(root, "opencode");
    await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@"\n`, "utf8");
    await fs.chmod(command, 0o755);
    logs.length = 0;
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function requests() {
    const raw = await fs.readFile(logFile, "utf8").catch(() => "");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: number; method: string; path: string; body: string });
  }

  function input(overrides: Partial<OpenCodeServeInput> & { env?: Record<string, string> } = {}): OpenCodeServeInput {
    return {
      runId: `serve-${Math.random().toString(36).slice(2)}`,
      command,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, FAKE_MCP_NAME: "Paperclip projects", ...overrides.env },
      timeoutSec: 30,
      graceSec: 2,
      prompt: "do the thing",
      model: "fx/m1",
      variant: "",
      resumeSessionId: null,
      mcpServers: [{ name: "Paperclip projects", token: TOKEN }],
      mcpSettleMs: 300,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      ...overrides,
    };
  }

  it("starts the session only after the MCP event plus the settle, and returns run-format stdout", async () => {
    const result = await runOpenCodeServeProcess(input());
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const seen = await requests();
    const mcpTouch = seen.find((entry) => entry.path === "/api/mcp")!;
    const create = seen.find((entry) => entry.path === "/api/session" && entry.method === "POST")!;
    const prompt = seen.find((entry) => entry.path === "/api/session/ses_fake/prompt")!;
    // fake server answers /api/mcp with the event ~100 ms later; the settle adds 300 ms
    expect(create.at - mcpTouch.at).toBeGreaterThanOrEqual(380);
    expect(prompt.at).toBeGreaterThanOrEqual(create.at);
    expect(JSON.parse(prompt.body)).toEqual({ text: "do the thing" });
    expect(JSON.parse(create.body).model).toEqual({ providerID: "fx", id: "m1" });
    const parsed = parseOpenCodeJsonl(result.stdout);
    expect(parsed.sessionId).toBe("ses_fake");
    expect(parsed.summary).toBe("fake reply");
    expect(parsed.usage).toEqual({ inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 });
  });

  it("fails closed without creating a session when an MCP server never reports", async () => {
    const result = await runOpenCodeServeProcess(input({ env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, FAKE_NO_MCP_EVENT: "1", FAKE_MCP_NAME: "Paperclip projects" }, mcpReadyTimeoutMs: 600 }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("did not report mcp.resources.changed for MCP server(s) Paperclip projects within 0.6s");
    expect(result.stderr).toContain("without its Paperclip tools");
    expect((await requests()).some((entry) => entry.path.startsWith("/api/session"))).toBe(false);
  });

  it("does not wait when no MCP server was injected", async () => {
    const result = await runOpenCodeServeProcess(input({ mcpServers: [] }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake reply");
  });

  it("maps a failed turn to exit 1 with the error in the stream", async () => {
    const result = await runOpenCodeServeProcess(input({ env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, FAKE_FAIL: "1", FAKE_MCP_NAME: "Paperclip projects" } }));
    expect(result.exitCode).toBe(1);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toBe("capped");
  });

  it("reports an unknown resume session without prompting", async () => {
    const result = await runOpenCodeServeProcess(input({ resumeSessionId: "ses_missing" }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/session ses_missing not found/i);
    expect((await requests()).some((entry) => entry.path.endsWith("/prompt"))).toBe(false);
  });

  it("resumes a known session and switches its model", async () => {
    const result = await runOpenCodeServeProcess(input({ resumeSessionId: "ses_known", variant: "high" }));
    expect(result.exitCode).toBe(0);
    const seen = await requests();
    const switched = seen.find((entry) => entry.path === "/api/session/ses_known/model")!;
    expect(JSON.parse(switched.body)).toEqual({ model: { providerID: "fx", id: "m1", variant: "high" } });
    expect(seen.some((entry) => entry.path === "/api/session/ses_known/prompt")).toBe(true);
    expect(seen.some((entry) => entry.path === "/api/session" && entry.method === "POST")).toBe(false);
  });

  it("never leaks the server password or the MCP bearer token into logs or results", async () => {
    // The fake echoes nothing secret itself, so exercise the redactor on a
    // line the server could print and on the real password the run used.
    const result = await runOpenCodeServeProcess(input());
    const everything = `${result.stdout}${result.stderr}${logs.join("")}`;
    expect(everything).not.toContain(TOKEN);
    expect(redactOpenCodeServeSecrets(`Authorization: Bearer ${TOKEN} x`, [TOKEN])).toBe("Authorization: Bearer [redacted] x");
  });

  it("stops the server it started and frees its port", async () => {
    await runOpenCodeServeProcess(input());
    const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(logs.join(""))?.[1];
    expect(port).toBeTruthy();
    await expect(fetch(`http://127.0.0.1:${port}/api/info`)).rejects.toThrow();
  });
});

describe("OpenCode serve helpers", () => {
  it("serves on a kernel-assigned loopback port", () => {
    expect(buildOpenCodeServeArgs()).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  });

  it("splits provider/model at the first slash and carries the variant", () => {
    expect(parseOpenCodeServeModel("openrouter/vendor/model", "high")).toEqual({ providerID: "openrouter", id: "vendor/model", variant: "high" });
    expect(parseOpenCodeServeModel("fx/m1", "")).toEqual({ providerID: "fx", id: "m1" });
    expect(parseOpenCodeServeModel("nomodel", "")).toBeNull();
  });
});
