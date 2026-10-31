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
const REJECT_MESSAGE = "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.";

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

  it("names each MCP server's reported status when the gate times out", async () => {
    const status = JSON.stringify([{ name: "Paperclip projects", status: { status: "needs_auth", error: "requires a login" }, integrationID: "mcp_1" }]);
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_NO_MCP_EVENT: "1", FAKE_MCP_STATUS: status }), mcpReadyTimeoutMs: 600 }));

    expect(result.exitCode).toBe(1);
    const message = parseOpenCodeJsonl(result.stdout).errorMessage;
    expect(message).toContain("within 0.6s (reported status: Paperclip projects: needs_auth (requires a login));");
    expect(result.stderr).toContain("Paperclip projects: needs_auth (requires a login)");
  });

  it("says a server is not reported when the status read lists nothing for it", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_NO_MCP_EVENT: "1" }), mcpReadyTimeoutMs: 600 }));

    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toContain("(reported status: Paperclip projects: not reported);");
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

  it("auto-rejects a permission request for its session and finishes the turn, like opencode run", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_PERMISSION: "1" }), timeoutSec: 0 }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("! permission requested: shell (echo hi); auto-rejecting\n");
    const reply = (await requests()).find((entry) => entry.path === "/api/session/ses_fake/permission/per_1/reply")!;
    expect(JSON.parse(reply.body)).toEqual({ decision: "reject", message: REJECT_MESSAGE });
    const toolUse = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; part?: { tool?: string; state?: Record<string, unknown> } })
      .find((event) => event.type === "tool_use");
    expect(toolUse?.part?.tool).toBe("shell");
    expect(toolUse?.part?.state).toMatchObject({ status: "error", error: REJECT_MESSAGE });
    await expectServerStopped();
  });

  it("rejects a child session's permission request too, to the child's own session id", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_PERMISSION: "1" }), timeoutSec: 0 }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("! permission requested: shell (rm -rf /); auto-rejecting\n");
    const replies = (await requests()).filter((entry) => entry.path.includes("/permission/"));
    expect(replies.map((entry) => entry.path).sort()).toEqual([
      "/api/session/ses_fake/permission/per_1/reply",
      "/api/session/ses_other/permission/per_other/reply",
    ]);
    for (const reply of replies) expect(JSON.parse(reply.body)).toEqual({ decision: "reject", message: REJECT_MESSAGE });
  });

  it("fails the run instead of hanging when a permission reply is refused", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_PERMISSION: "1", FAKE_PERMISSION_REPLY_STATUS: "500" }), timeoutSec: 0 }));

    expect(result.exitCode).toBe(1);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toMatch(/permission request per_(1|other) could not be rejected: HTTP 500/);
    expect(result.stderr).toContain("! permission requested: shell (echo hi); auto-rejecting");
    await expectServerStopped();
  });

  it("cancels a question form from any session and ends the run as a failure that names the question", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_QUESTION: "1" }), timeoutSec: 0 }));

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    const deletes = (await requests()).filter((entry) => entry.method === "DELETE");
    expect(deletes.map((entry) => entry.path).sort()).toEqual([
      "/api/session/ses_fake/form/frm_1",
      "/api/session/ses_other/form/frm_other",
    ]);
    expect(result.stderr.match(/! question requested: Pick one \(Which option\?\); cancelling\n/g)).toHaveLength(2);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toBe(
      "OpenCode asked a question (Pick one) that a non-interactive run cannot answer; it was cancelled and the run stopped",
    );
    expect(result.stdout).toContain("The user dismissed this question");
    await expectServerStopped();
  });

  it("fails the run instead of hanging when a question cannot be cancelled", async () => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_QUESTION: "1", FAKE_FORM_DELETE_STATUS: "500" }), timeoutSec: 0 }));

    expect(result.exitCode).toBe(1);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toContain("could not be cancelled: HTTP 500");
    expect(result.stderr).toContain("! question requested: Pick one (Which option?); cancelling");
    await expectServerStopped();
  });

  it.each(["close-stream", "exit"])("reports a failure when the turn ends early (%s) instead of an exit-0 success", async (mode) => {
    const result = await runOpenCodeServeProcess(input({ env: serverEnv({ FAKE_ENDS_MID_TURN: mode }) }));

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(parseOpenCodeJsonl(result.stdout).errorMessage).toContain("ended before the turn finished");
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
