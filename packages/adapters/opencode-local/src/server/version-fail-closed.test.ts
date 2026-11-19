import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import {
  classifyOpenCodeCliVersionOutput,
  resolveOpenCodeVersionProbeTimeoutSec,
  unsupportedDetectedOpenCodeV2CliVersionMessage,
} from "./version.js";

const HELLO_JSONL = [
  { type: "step_start", sessionID: "session-1" },
  { type: "text", sessionID: "session-1", part: { text: "hello" } },
  {
    type: "step_finish",
    sessionID: "session-1",
    part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  },
].map((event) => JSON.stringify(event)).join("\n");

// How the fake binary answers `--version`. Each outcome used to parse to "no
// version", which both paths treated as V1.
const UNDETERMINED_VERSION_OUTCOMES: Array<{
  name: string;
  versionBody: string;
  code: "opencode_cli_version_unsupported" | "opencode_cli_version_unknown";
  message: RegExp;
  timeoutMs?: number;
}> = [
  {
    name: "a prerelease 2.x",
    versionBody: "printf '2.2.4-beta.1\\n'",
    code: "opencode_cli_version_unsupported",
    message: /Unsupported OpenCode CLI version: 2\.2\.4-beta\.1 reported by .*Prerelease builds are not supported/,
  },
  {
    name: "empty output",
    versionBody: ":",
    code: "opencode_cli_version_unknown",
    message: /Could not determine the OpenCode CLI version of .*empty --version output.*Refusing to assume V1/,
  },
  {
    name: "garbage output",
    versionBody: "printf 'not a version at all\\n'",
    code: "opencode_cli_version_unknown",
    message: /Could not determine the OpenCode CLI version of .*unrecognized --version output "not a version at all".*Refusing to assume V1/,
  },
  {
    name: "a nonzero exit",
    versionBody: "echo 'probe exploded' >&2; exit 3",
    code: "opencode_cli_version_unknown",
    message: /Could not determine the OpenCode CLI version of .*--version exited with code 3.*Refusing to assume V1/,
  },
  {
    name: "a probe that times out",
    versionBody: "exec sleep 60",
    code: "opencode_cli_version_unknown",
    message: /Could not determine the OpenCode CLI version of .*--version timed out after \d+s.*Refusing to assume V1/,
    timeoutMs: 40_000,
  },
];

describe("opencode version probe fails closed", () => {
  let root: string;
  let markerDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-failclosed-"));
    markerDir = path.join(root, "markers");
    await fs.mkdir(markerDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // `run` and `models` leave a marker, so a refused version is proven to have
  // launched nothing beyond `--version`.
  async function writeStub(versionBody: string): Promise<string> {
    const commandPath = path.join(root, "opencode");
    await fs.writeFile(
      commandPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        `  --version) ${versionBody} ;;`,
        `  models) touch '${markerDir}/models'; printf 'openai/gpt-5\\n' ;;`,
        `  run) cat > /dev/null; printf '%s' "$*" > '${markerDir}/run-args'; cat <<'EOF'`,
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

  const launched = async (marker: string) =>
    fs.access(path.join(markerDir, marker)).then(() => true, () => false);

  function envTestContext(command: string, extra: Record<string, unknown> = {}): AdapterEnvironmentTestContext {
    return {
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd: root, model: "openai/gpt-5", ...extra },
    } as AdapterEnvironmentTestContext;
  }

  function runExecute(command: string, extra: Record<string, unknown> = {}) {
    return execute({
      runId: "run-failclosed",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: root, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" }, ...extra },
      context: {},
      onLog: async () => {},
    });
  }

  describe.each(UNDETERMINED_VERSION_OUTCOMES)("when --version reports $name", (outcome) => {
    it("execute refuses and launches nothing", async () => {
      const command = await writeStub(outcome.versionBody);

      await expect(runExecute(command, { timeoutSec: outcome.timeoutMs ? 1 : 0 })).rejects.toThrow(outcome.message);

      expect(await launched("run-args")).toBe(false);
      expect(await launched("models")).toBe(false);
    }, outcome.timeoutMs ?? 5_000);

    it("testEnvironment fails and stops before the models and hello probes", async () => {
      const command = await writeStub(outcome.versionBody);

      const result = await testEnvironment(envTestContext(command, { variant: "high" }));

      expect(result.status).toBe("fail");
      expect(result.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: outcome.code, level: "error", message: expect.stringMatching(outcome.message) }),
      ]));
      const codes = result.checks.map((check) => check.code);
      expect(codes).not.toContain("opencode_models_discovered");
      expect(codes).not.toContain("opencode_model_configured");
      expect(codes).not.toContain("opencode_hello_probe_passed");
      expect(await launched("run-args")).toBe(false);
      expect(await launched("models")).toBe(false);
    }, outcome.timeoutMs ?? 5_000);
  });

  // A fixture-style fake that answers every argument with the same text (here a
  // models table) has no determinable version. It must be refused, not run as V1.
  it("refuses a fake binary that prints the same non-version text for every argument", async () => {
    const commandPath = path.join(root, "opencode");
    await fs.writeFile(commandPath, `#!/bin/sh\ntouch '${markerDir}/launched'\nprintf 'provider  model\\nopenai  gpt-5\\n'\n`, "utf8");
    await fs.chmod(commandPath, 0o755);

    await expect(runExecute(commandPath)).rejects.toThrow(/unrecognized --version output "provider model openai gpt-5".*Refusing to assume V1/);
    const result = await testEnvironment(envTestContext(commandPath));

    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("opencode_cli_version_unknown");
    expect(await launched("run-args")).toBe(false);
  });

  it("execute gives a slow --version probe time when the run has no timeout (timeoutSec 0)", async () => {
    // Slower than the old one-second probe floor, then reports a refused 2.x.
    const command = await writeStub("sleep 2; printf '2.3.0\\n'");

    await expect(runExecute(command, { timeoutSec: 0 })).rejects.toThrow(
      unsupportedDetectedOpenCodeV2CliVersionMessage(command, "2.3.0"),
    );
    expect(await launched("run-args")).toBe(false);
  }, 20_000);

  it("testEnvironment stops before the models and hello probes for an unsupported detected 2.x", async () => {
    const command = await writeStub("printf '2.3.0\\n'");

    const result = await testEnvironment(envTestContext(command));

    expect(result.status).toBe("fail");
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("opencode_cli_version_unsupported");
    expect(codes).not.toContain("opencode_hello_probe_passed");
    expect(await launched("run-args")).toBe(false);
    expect(await launched("models")).toBe(false);
  });

  it("resolves the probe timeout to a bounded default for an unset or zero run timeout", () => {
    expect(resolveOpenCodeVersionProbeTimeoutSec(0)).toBe(10);
    expect(resolveOpenCodeVersionProbeTimeoutSec(-5)).toBe(10);
    expect(resolveOpenCodeVersionProbeTimeoutSec(Number.NaN)).toBe(10);
    expect(resolveOpenCodeVersionProbeTimeoutSec(5)).toBe(5);
    expect(resolveOpenCodeVersionProbeTimeoutSec(3600)).toBe(20);
  });

  describe("positive controls", () => {
    it("still runs a parseable stable V1 binary in execute and testEnvironment", async () => {
      const command = await writeStub("printf '1.18.33\\n'");

      const result = await runExecute(command);
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(path.join(markerDir, "run-args"), "utf8")).toContain("--format json");
      expect(await fs.readFile(path.join(markerDir, "run-args"), "utf8")).not.toContain("--standalone");
      await fs.rm(path.join(markerDir, "run-args"));

      const envResult = await testEnvironment(envTestContext(command, { variant: "high" }));
      expect(envResult.status).toBe("pass");
      expect(await fs.readFile(path.join(markerDir, "run-args"), "utf8")).toBe(
        "run --format json --model openai/gpt-5 --variant high",
      );
    });

    it("still runs the parseable stable pinned V2 binary in testEnvironment", async () => {
      const command = await writeStub("printf '2.2.4\\n'");

      const envResult = await testEnvironment(envTestContext(command, { variant: "high" }));
      expect(envResult.status).toBe("pass");
      expect(await fs.readFile(path.join(markerDir, "run-args"), "utf8")).toBe(
        "run --standalone --format json --model openai/gpt-5#high",
      );
    });

    it("still runs the parseable stable pinned V2 binary in execute", async () => {
      const fakeServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode-serve.mjs");
      const commandPath = path.join(root, "opencode");
      await fs.writeFile(
        commandPath,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '2.2.4\\n'; exit 0; fi\nexec "${process.execPath}" "${fakeServer}" "$@"\n`,
        "utf8",
      );
      await fs.chmod(commandPath, 0o755);

      const result = await runExecute(commandPath, {
        env: { OPENCODE_ALLOW_ALL_MODELS: "1", FAKE_LOG: path.join(root, "requests.jsonl") },
      });
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("classifyOpenCodeCliVersionOutput", () => {
  it("accepts a stable version in the forms the CLI prints", () => {
    for (const output of ["1.18.33\n", "opencode 2.2.4\n", "v2.2.4", "\n2.2.4\n"]) {
      const probe = classifyOpenCodeCliVersionOutput(output);
      expect(probe.ok).toBe(true);
    }
  });

  it("names a prerelease or build-suffixed version rather than calling it garbage", () => {
    expect(classifyOpenCodeCliVersionOutput("2.2.4-beta.1\n")).toMatchObject({ ok: false, reason: "prerelease", detail: "2.2.4-beta.1" });
    expect(classifyOpenCodeCliVersionOutput("opencode 1.19.0-rc.2")).toMatchObject({ ok: false, reason: "prerelease", detail: "1.19.0-rc.2" });
    expect(classifyOpenCodeCliVersionOutput("2.2.4+build.7")).toMatchObject({ ok: false, reason: "prerelease" });
  });

  it("separates empty from unrecognized output", () => {
    expect(classifyOpenCodeCliVersionOutput("\n \n")).toMatchObject({ ok: false, reason: "empty_output" });
    expect(classifyOpenCodeCliVersionOutput("command not found")).toMatchObject({ ok: false, reason: "unparseable_output" });
  });
});
