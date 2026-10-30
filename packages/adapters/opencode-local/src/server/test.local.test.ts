import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { unsupportedDetectedOpenCodeV2CliVersionMessage } from "./version.js";

const HELLO_JSONL = [
  { type: "step_start", sessionID: "session-1" },
  { type: "text", sessionID: "session-1", part: { text: "hello" } },
  {
    type: "step_finish",
    sessionID: "session-1",
    part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  },
].map((event) => JSON.stringify(event)).join("\n");

describe("opencode testEnvironment — binary detected on PATH", () => {
  let root: string;
  let runArgsPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-envtest-detected-"));
    runArgsPath = path.join(root, "run-args.txt");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeStub(version: string): Promise<string> {
    const commandPath = path.join(root, "opencode");
    await fs.writeFile(
      commandPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        `  --version) printf '%s\\n' '${version}' ;;`,
        "  models) printf 'openai/gpt-5\\n' ;;",
        `  run) cat > /dev/null; printf '%s' "$*" > '${runArgsPath}'; cat <<'EOF'`,
        HELLO_JSONL,
        "EOF",
        "  ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);
    return commandPath;
  }

  function envTestContext(command: string, extra: Record<string, unknown> = {}): AdapterEnvironmentTestContext {
    return {
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd: root, model: "openai/gpt-5", variant: "high", ...extra },
    } as AdapterEnvironmentTestContext;
  }

  it("fails with the error execute throws when the detected V2 binary is not the pinned version", async () => {
    const command = await writeStub("2.3.0");
    const message = unsupportedDetectedOpenCodeV2CliVersionMessage(command, "2.3.0");

    const result = await testEnvironment(envTestContext(command));

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "opencode_cli_version_unsupported", level: "error", message }),
    ]));
    await expect(
      execute({
        runId: "run-detected-unsupported-v2",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command, cwd: root, model: "openai/gpt-5" },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow(message);
  });

  it("passes the pinned detected V2 binary and probes it with V2 argv", async () => {
    const command = await writeStub("2.2.4");

    const result = await testEnvironment(envTestContext(command));

    expect(result.checks.map((check) => check.code)).not.toContain("opencode_cli_version_unsupported");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "opencode_command_resolvable" }),
      expect.objectContaining({ code: "opencode_hello_probe_passed" }),
    ]));
    expect(result.status).toBe("pass");
    expect(await fs.readFile(runArgsPath, "utf8")).toBe(
      "run --standalone --format json --model openai/gpt-5#high",
    );
  });

  it("keeps V1 argv for a detected V1 binary", async () => {
    const command = await writeStub("1.18.33");

    const result = await testEnvironment(envTestContext(command));

    expect(result.status).toBe("pass");
    expect(await fs.readFile(runArgsPath, "utf8")).toBe(
      "run --format json --model openai/gpt-5 --variant high",
    );
  });
});
