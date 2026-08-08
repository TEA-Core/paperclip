import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  tempCodexHome: "/tmp/paperclip-codex-workspace-path-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) => `[paperclip] ${reason}\n`,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute } from "./execute.js";

const cleanupDirs: string[] = [];

async function buildWorkspace(): Promise<{ workspaceDir: string; instructionsFilePath: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-workspace-path-"));
  cleanupDirs.push(rootDir);
  const workspaceDir = path.join(rootDir, "workspace");
  const agentDir = path.join(rootDir, "agent");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const instructionsFilePath = path.join(agentDir, "AGENT.md");
  await writeFile(instructionsFilePath, "You are a Paperclip agent.\n", "utf8");
  return { workspaceDir, instructionsFilePath };
}

function buildContext(config: Record<string, unknown>) {
  return {
    runId: "run-workspace-path-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      engine: "cli",
      outputInactivityTimeoutMs: null,
      env: { OPENAI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

function capturedStdin(): string {
  const call = runAdapterExecutionTargetProcess.mock.calls.at(-1) as unknown as unknown[] | undefined;
  const options = call?.[4] as { stdin?: string } | undefined;
  return options?.stdin ?? "";
}

describe("codex_local workspace path injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("injects the literal workspace path into the prompt alongside the loaded instructions", async () => {
    const { workspaceDir, instructionsFilePath } = await buildWorkspace();

    const result = await execute(buildContext({ cwd: workspaceDir, instructionsFilePath }) as never);

    expect(result.exitCode).toBe(0);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);

    const prompt = capturedStdin();
    expect(prompt).toContain("You are a Paperclip agent.");
    expect(prompt).toContain(
      `Your execution workspace path is: ${workspaceDir} (also available as the environment variable $PAPERCLIP_WORKSPACE_CWD).`,
    );
  });

  it("keeps the prompt free of the workspace path directive when no instructions file is configured", async () => {
    const { workspaceDir } = await buildWorkspace();

    const result = await execute(buildContext({ cwd: workspaceDir }) as never);

    expect(result.exitCode).toBe(0);
    expect(capturedStdin()).not.toContain("Your execution workspace path is:");
  });
});
