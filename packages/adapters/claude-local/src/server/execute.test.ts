import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcessMock, ensureCommandResolvableMock, resolveCommandForLogsMock } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcessMock: vi.fn(),
  // Typed to match `ensureAdapterExecutionTargetCommandResolvable`. With a
  // bare `async () => {}` the recorded call tuple is `[]`, so `calls.at(-1)?.[3]`
  // — the sanitized env this suite exists to assert on — does not typecheck.
  ensureCommandResolvableMock: vi.fn(async (
    _command: string,
    _target: unknown,
    _cwd: string,
    _env: NodeJS.ProcessEnv,
    _options?: { installCommand?: string | null; timeoutSec?: number | null },
  ) => {}),
  resolveCommandForLogsMock: vi.fn(async (command: string) => command),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => false,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  adapterExecutionTargetUsesManagedHome: () => false,
  adapterExecutionTargetUsesPaperclipBridge: () => false,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandResolvableMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
    workspaceRemoteDir: null,
    restoreWorkspace: async () => {},
    runtimeRootDir: null,
    assetDirs: {},
  })),
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) =>
    executionTarget ?? { kind: "local" },
  readAdapterExecutionTargetHomeDir: vi.fn(async () => null),
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  runAdapterExecutionTargetProcess: runAdapterExecutionTargetProcessMock,
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: new Date().toISOString(),
  })),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries: async () => [],
  };
});

vi.mock("./skills.js", () => ({
  resolveClaudeDesiredSkillNames: () => [],
}));

vi.mock("./acp.js", async () => {
  const actual = await vi.importActual<typeof import("./acp.js")>("./acp.js");
  return {
    ...actual,
    resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli" as const, explicit: false }),
  };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    isBedrockModelId: () => false,
  };
});

vi.mock("./prompt-cache.js", () => ({
  prepareClaudePromptBundle: async () => ({
    addDir: null,
    instructionsFilePath: null,
    instructionsType: "none" as const,
    hash: "",
  }),
}));

vi.mock("./permissions.js", () => ({
  buildClaudeExecutionPermissionArgs: () => [],
}));

vi.mock("./cli-capabilities.js", () => ({
  claudeCommandSupportsEffortFlag: async () => false,
}));

async function makeSandboxHomeDir() {
  const root = path.join(os.tmpdir(), `paperclip-claude-sandbox-home-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await import("node:fs/promises").then((fs) => fs.mkdir(root, { recursive: true }));
  return root;
}

const cleanupDirs: string[] = [];

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";

describe("claude local execution — sanitizeInheritedPaperclipEnv at spawn points", () => {
  function makeCtx(): AdapterExecutionContext {
    return {
      runId: "run-sanitize-local",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", model: "claude-sonnet", cwd: process.cwd() },
      context: {},
      onLog: async () => {},
    } as AdapterExecutionContext;
  }

  beforeEach(() => {
    runAdapterExecutionTargetProcessMock.mockReset();
    runAdapterExecutionTargetProcessMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const fs = await import("node:fs/promises");
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("passes process.env through the shared sanitizer before spawning", async () => {
    const spy = vi.spyOn(serverUtils, "sanitizeInheritedPaperclipEnv");

    process.env.DATABASE_URL = "postgres://example.test/paperclip";
    process.env.ZZZ_SENTINEL = "sentinel-value";
    try {
      await execute(makeCtx());
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.ZZZ_SENTINEL;
    }

    expect(spy).toHaveBeenCalledWith(process.env);
    const resolveCall = ensureCommandResolvableMock.mock.calls.at(-1);
    const runtimeEnv = resolveCall?.[3];
    // Assert it is present rather than optional-chaining: a missing call would
    // otherwise satisfy `toBeUndefined()` and quietly stop testing the strip.
    expect(runtimeEnv).toBeDefined();
    expect(runtimeEnv!.DATABASE_URL).toBeUndefined();
    expect(runtimeEnv!.ZZZ_SENTINEL).toBe("sentinel-value");
  });
});
