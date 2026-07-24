import { afterEach, describe, expect, it } from "vitest";

import { buildOpenCodeRunArgs, ensureRemoteOpenCodeModelConfiguredAndAvailable } from "./execute.js";

describe("buildOpenCodeRunArgs", () => {
  // SUP-9238: OpenCode 1.18+ re-roots its session on PWD rather than the real
  // process cwd, so relying on the spawn cwd alone let a stale inherited PWD
  // move the whole session (and its write permissions) off the provisioned
  // execution workspace. Pin the run directory on the command line too.
  it("pins the execution directory with --dir", () => {
    expect(
      buildOpenCodeRunArgs({
        dir: "/workspaces/SUP-9238",
        model: "router/coder",
        variant: "",
        extraArgs: [],
        printLogs: false,
        resumeSessionId: null,
      }),
    ).toEqual(["run", "--format", "json", "--dir", "/workspaces/SUP-9238", "--model", "router/coder"]);
  });

  it("omits --dir when no execution directory is known", () => {
    expect(
      buildOpenCodeRunArgs({
        dir: "",
        model: "",
        variant: "",
        extraArgs: [],
        printLogs: false,
        resumeSessionId: null,
      }),
    ).toEqual(["run", "--format", "json"]);
  });

  it("keeps resume, variant and caller-supplied args alongside --dir", () => {
    expect(
      buildOpenCodeRunArgs({
        dir: "/workspaces/SUP-9238",
        model: "router/coder",
        variant: "high",
        extraArgs: ["--auto"],
        printLogs: true,
        resumeSessionId: "ses_123",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--print-logs",
      "--dir",
      "/workspaces/SUP-9238",
      "--session",
      "ses_123",
      "--model",
      "router/coder",
      "--variant",
      "high",
      "--auto",
    ]);
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});
