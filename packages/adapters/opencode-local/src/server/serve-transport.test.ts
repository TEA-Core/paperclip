import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CAPTURE_BYTES } from "@paperclipai/adapter-utils/server-utils";
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

  function serverEnv(extra: Record<string, string> = {}) {
    return { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, FAKE_MCP_NAME: "Paperclip projects", ...extra };
  }

  async function expectServerStopped() {
    const port = await fs.readFile(`${logFile}.port`, "utf8");
    await expect(fetch(`http://127.0.0.1:${port}/api/info`)).rejects.toThrow();
  }

  function input(overrides: Partial<OpenCodeServeInput> & { env?: Record<string, string> } = {}): OpenCodeServeInput {
    return {
      runId: `serve-${Math.random().toString(36).slice(2)}`,
      command,
      cwd: root,
      env: serverEnv(),
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
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_NO_MCP_EVENT: "1" }), mcpReadyTimeoutMs: 600 }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("did not report mcp.resources.changed for MCP server(s) Paperclip projects within 0.6s");
    expect(result.stderr).toContain("without its Paperclip tools");
    expect(result.stderr).not.toContain("listening on");
    // The clear text is a stdout `error` event so it becomes the run's errorMessage.
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toContain("did not report mcp.resources.changed for MCP server(s) Paperclip projects");
    expect((await requests()).some((entry) => entry.path.startsWith("/api/session"))).toBe(false);
    await expectServerStopped();
  });

  it("bounds the MCP touch request by the same readiness deadline", async () => {
    const startedAt = Date.now();
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_HANG_MCP: "1" }), mcpReadyTimeoutMs: 500 }));
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.exitCode).toBe(1);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toContain("did not answer its MCP status request within 0.5s");
    expect((await requests()).some((entry) => entry.path.startsWith("/api/session"))).toBe(false);
    await expectServerStopped();
  });

  it("does not wait when no MCP server was injected", async () => {
    const result = await runOpenCodeServeProcess(input({ mcpServers: [] }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake reply");
  });

  it("maps a failed turn to exit 1 with the error in the stream", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_FAIL: "1" }) }));
    expect(result.exitCode).toBe(1);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toBe("capped");
    expect(result.stderr).toContain("capped");
  });

  it("reports an unknown resume session without prompting", async () => {
    const result = await runOpenCodeServeProcess(input({ resumeSessionId: "ses_missing" }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/session ses_missing not found/i);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toMatch(/session ses_missing not found/i);
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

  it("never leaks the server password, its Authorization header or the MCP bearer token", async () => {
    // The fake echoes all three into its output, its stderr and an event text.
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_SECRET: TOKEN }) }));
    expect(result.exitCode).toBe(0);
    const password = await fs.readFile(`${logFile}.password`, "utf8");
    const credential = Buffer.from(`opencode:${password}`).toString("base64");
    const everything = `${result.stdout}${result.stderr}${logs.join("")}`;
    expect(everything).toContain("[redacted]");
    expect(result.stderr).toContain("authorization=Basic [redacted]");
    for (const secret of [TOKEN, password, credential]) expect(everything).not.toContain(secret);
    expect(redactOpenCodeServeSecrets(`Authorization: Bearer ${TOKEN} x`, [TOKEN])).toBe("Authorization: Bearer [redacted] x");
  });

  it("caps captured output like the one-shot path", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_BIG_TEXT_BYTES: String(MAX_CAPTURE_BYTES + 1_000_000) }) }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  });

  it("keeps the wall-clock timeout and frees the server", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_HANG_TURN: "1" }), timeoutSec: 1 }));
    expect(result.timedOut).toBe(true);
    await expectServerStopped();
  });

  it("escalates to SIGKILL when the server ignores SIGTERM", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_IGNORE_SIGTERM: "1" }), graceSec: 1 }));
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    await expectServerStopped();
  });

  it("still stops the server when the log sink rejects", async () => {
    const result = await runOpenCodeServeProcess(
      input({
        env: serverEnv({ FAKE_NO_MCP_EVENT: "1" }),
        mcpReadyTimeoutMs: 400,
        onLog: async () => {
          throw new Error("log store unavailable");
        },
      }),
    );
    expect(result.exitCode).toBe(1);
    await expectServerStopped();
  });

  it("stops the server it started and frees its port", async () => {
    await runOpenCodeServeProcess(input());
    await expectServerStopped();
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
