import { afterEach, describe, expect, it } from "vitest";

import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import {
  registerRunProcessGroupCounter,
  RUN_PROCESS_CAP_ENV_KEY,
  RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
} from "@paperclipai/adapter-utils/run-process-cap";
import type { PaperclipSemanticToolDefinition } from "../../vendor/paperclip-runner/index.js";
import {
  admitNativeRunnerSpawnCap,
  buildNativeRunnerArguments,
  buildNativeRunnerPreparePayload,
  executeNativeCodexRunner,
} from "./native-codex-runner.js";

describe("buildNativeRunnerArguments", () => {
  it("binds every durable identity without exposing the bootstrap ticket", () => {
    const args = buildNativeRunnerArguments({
      connectUrl: "ws://127.0.0.1:3000/api/runner/v1/connect/run-1",
      stateDirectory: "/tmp/runner-state",
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      maxRuntimeMs: 60_000,
    });
    expect(args).toContain("--connect-url");
    expect(args).toContain("--runner-digest");
    expect(args.join(" ")).not.toContain("bootstrap");
  });
});

const tool: PaperclipSemanticToolDefinition = {
  name: "get_task_context",
  description: "Read the active task context.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  annotations: {
    semanticContract: "paperclip.semantic-action.v1",
    version: 1,
    placement: "always",
    effect: "read",
    requiredClaims: [],
  },
};

describe("buildNativeRunnerPreparePayload", () => {
  it("binds the coordinator tool projection to run.prepare", () => {
    expect(buildNativeRunnerPreparePayload({
      cwd: "/workspace",
      model: "test-model",
      resumeProviderSessionId: "thread-1",
      completionContract: { revision: "1", criterionIds: ["objective"] },
      semanticTools: [tool],
      providerLaunch: {
        command: "/bin/fake-codex",
        args: ["app-server"],
        providerVersion: "fake-1",
      },
    })).toMatchObject({
      provider: {
        kind: "codex",
        provider: "codex",
        driver: "codex_app_server",
        providerSessionId: "thread-1",
      },
      authorizedTools: {
        schema: "paperclip.runner.authorized-tools.v1",
        schemaVersion: 1,
        catalogDigest:
          "sha256:4e0332535c9e2ff1f5e43089517ee1b46654bfc9cb2ed51efbea4be50db21009",
        operations: [{ operationId: "get_task_context", version: 1 }],
      },
    });
  });
});

const originalNativeCapEnv = process.env[RUN_PROCESS_CAP_ENV_KEY];

afterEach(() => {
  registerRunProcessGroupCounter(null);
  runningProcesses.delete("native-cap-run");
  if (originalNativeCapEnv === undefined) {
    delete process.env[RUN_PROCESS_CAP_ENV_KEY];
  } else {
    process.env[RUN_PROCESS_CAP_ENV_KEY] = originalNativeCapEnv;
  }
});

describe("admitNativeRunnerSpawnCap (native per-run process cap)", () => {
  it("refuses a native spawn at the cap with the seam's error code", () => {
    process.env[RUN_PROCESS_CAP_ENV_KEY] = "5";
    registerRunProcessGroupCounter(() => 5);
    runningProcesses.set("native-cap-run", {
      child: { pid: 4242 } as never,
      graceSec: 1,
      processGroupId: 88888,
    });

    const refusal = admitNativeRunnerSpawnCap({ runId: "native-cap-run" });
    expect(refusal?.code).toBe(RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE);
    expect(refusal?.resultJson).toEqual({
      errorCode: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
      cap: 5,
      current: 5,
      processGroupId: 88888,
      runId: "native-cap-run",
    });
  });

  it("admits a native spawn at cap - 1", () => {
    process.env[RUN_PROCESS_CAP_ENV_KEY] = "5";
    registerRunProcessGroupCounter(() => 4);
    runningProcesses.set("native-cap-run", {
      child: { pid: 4242 } as never,
      graceSec: 1,
      processGroupId: 88888,
    });

    expect(admitNativeRunnerSpawnCap({ runId: "native-cap-run" })).toBeNull();
  });

  it("fails open when the run has no tracked group yet", () => {
    process.env[RUN_PROCESS_CAP_ENV_KEY] = "1";
    registerRunProcessGroupCounter(() => 99);
    expect(admitNativeRunnerSpawnCap({ runId: "no-tracked-group" })).toBeNull();
  });
});

describe("executeNativeCodexRunner (native spawn refused at the cap)", () => {
  it("refuses the runnerd spawn at the cap with the seam's error code, before touching the binary", async () => {
    process.env[RUN_PROCESS_CAP_ENV_KEY] = "5";
    registerRunProcessGroupCounter(() => 5);
    runningProcesses.set("native-cap-run", {
      child: { pid: 4242 } as never,
      graceSec: 1,
      processGroupId: 88888,
    });

    await expect(
      executeNativeCodexRunner({
        db: undefined as never,
        companyId: "company-1",
        issueId: "issue-1",
        runId: "native-cap-run",
        agentId: "agent-1",
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
        cwd: "/workspace",
        prompt: "hello",
        model: null,
        resumeProviderSessionId: null,
        completionContract: { revision: "1", criterionIds: ["objective"] },
        timeoutMs: 60_000,
        environment: {},
        onLog: async () => {},
        onSpawn: async () => {},
      }),
    ).rejects.toMatchObject({
      code: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
      resultJson: {
        errorCode: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
        cap: 5,
        current: 5,
        processGroupId: 88888,
        runId: "native-cap-run",
      },
    });
  });
});
