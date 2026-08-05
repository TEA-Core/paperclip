import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcessMock } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcessMock: vi.fn(),
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
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
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
  resolveAdapterExecutionTargetCommandForLogs: async (command: string) => command,
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
    resolvePaperclipDesiredSkillNames: () => [],
    removeMaintainerOnlySkillSymlinks: async () => [],
    ensurePaperclipSkillSymlink: async () => "skipped" as const,
  };
});

vi.mock("./models.js", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(async () => []),
  isTruthyEnvFlag: (value: unknown) => value === "true" || value === "1",
  parseOpenCodeModelsOutput: (stdout: string) => [],
  requireOpenCodeModelId: (model: unknown) => {
    const s = typeof model === "string" ? model.trim() : "";
    if (!s || !s.includes("/")) {
      throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
    }
    return s;
  },
}));

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import {
  buildOpenCodeRunArgs,
  classifyOpenCodeFailure,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  execute,
  resolveOpenCodeSessionResume,
} from "./execute.js";

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

// `opencode run --session <s> --dir <d>` where <d> is not the directory <s> was
// created in never terminates: opencode bootstraps <d>, then bootstraps the
// session's own recorded directory, exits its prompt loop, and then hangs with
// zero bytes on stdout. The process adapter waits on child exit, so the run row
// stays `running` forever. Never pair a resume with a directory we cannot prove
// the session belongs to.
describe("resolveOpenCodeSessionResume", () => {
  const base = {
    executionCwd: "/workspaces/wt-a",
    executionTargetMatches: true,
  };

  it("resumes when the session was saved for the same directory", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "/workspaces/wt-a" }),
    ).toEqual({ resume: true, sessionId: "ses_123" });
  });

  it("normalises the compared paths", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "/workspaces/wt-a/" }),
    ).toEqual({ resume: true, sessionId: "ses_123" });
  });

  it("refuses to resume into a different directory", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "/workspaces/wt-b" }),
    ).toEqual({ resume: false, sessionId: "ses_123", reason: "cwd_mismatch" });
  });

  // The regression: `agent_runtime_state.session_id` carries a session id with
  // no recorded cwd (state_json was `{}`), so an unknown cwd used to count as
  // "compatible" and resumed straight into the agent-home fallback workspace.
  it("refuses to resume a session whose directory is unknown", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "" }),
    ).toEqual({ resume: false, sessionId: "ses_123", reason: "unknown_cwd" });
  });

  it("refuses to resume across a changed remote execution identity", () => {
    expect(
      resolveOpenCodeSessionResume({
        ...base,
        sessionId: "ses_123",
        sessionCwd: "/workspaces/wt-a",
        executionTargetMatches: false,
      }),
    ).toEqual({ resume: false, sessionId: "ses_123", reason: "execution_target_mismatch" });
  });

  it("reports no session when there is nothing to resume", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "", sessionCwd: "/workspaces/wt-a" }),
    ).toEqual({ resume: false, sessionId: null, reason: "no_session" });
  });

  it("drops --session from the argv when the session cannot be resumed", () => {
    const decision = resolveOpenCodeSessionResume({
      ...base,
      sessionId: "ses_123",
      sessionCwd: "",
    });
    expect(
      buildOpenCodeRunArgs({
        dir: base.executionCwd,
        model: "router/coder",
        variant: "",
        extraArgs: [],
        printLogs: false,
        resumeSessionId: decision.resume ? decision.sessionId : null,
      }),
    ).not.toContain("--session");
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

describe("classifyOpenCodeFailure", () => {
  const base = {
    parsedError: "",
    stderrLine: "",
    adapterSessionId: "ses_abc",
    stderr: "",
    toolErrors: [],
  };

  it("classifies a non-zero exit code as opencode_exit_<N>", () => {
    const { errorCode, errorMeta } = classifyOpenCodeFailure({ ...base, exitCode: 1, signal: null });
    expect(errorCode).toBe("opencode_exit_1");
    expect(errorMeta).toEqual({
      adapterSessionId: "ses_abc",
      stderrTail: "",
    });
  });

  it("classifies a signal termination as opencode_signal_<SIGNAL>", () => {
    const { errorCode } = classifyOpenCodeFailure({ ...base, exitCode: null, signal: "SIGTERM" });
    expect(errorCode).toBe("opencode_signal_SIGTERM");
  });

  it("classifies a parsed JSONL error as opencode_tool_error", () => {
    const { errorCode, errorMeta } = classifyOpenCodeFailure({
      ...base,
      exitCode: 0,
      signal: null,
      parsedError: "model unavailable",
    });
    expect(errorCode).toBe("opencode_tool_error");
    expect(errorMeta.parsedError).toBe("model unavailable");
  });

  it("classifies stderr content as opencode_stderr_error", () => {
    const { errorCode, errorMeta } = classifyOpenCodeFailure({
      ...base,
      exitCode: 0,
      signal: null,
      stderrLine: "some error line",
      stderr: "some error line\n",
    });
    expect(errorCode).toBe("opencode_stderr_error");
    expect(errorMeta.stderrTail).toBe("some error line");
  });

  it("returns null errorCode for a clean success", () => {
    const { errorCode, errorMeta } = classifyOpenCodeFailure({
      ...base,
      exitCode: 0,
      signal: null,
    });
    expect(errorCode).toBeNull();
    expect(errorMeta).toEqual({
      adapterSessionId: "ses_abc",
      stderrTail: "",
    });
  });

  it("includes toolErrors in errorMeta when present", () => {
    const { errorMeta } = classifyOpenCodeFailure({
      ...base,
      exitCode: 1,
      signal: null,
      toolErrors: ["tool call failed: timeout"],
    });
    expect(errorMeta.toolErrors).toEqual(["tool call failed: timeout"]);
  });

  it("strips ANSI from stderrTail", () => {
    const { errorMeta } = classifyOpenCodeFailure({
      ...base,
      exitCode: 1,
      signal: null,
      stderr: "\x1b[31mError: something went wrong\x1b[0m\n",
    });
    expect(errorMeta.stderrTail).toBe("Error: something went wrong");
  });

  it("prioritises exit code over parsed error", () => {
    const { errorCode } = classifyOpenCodeFailure({
      ...base,
      exitCode: 2,
      signal: null,
      parsedError: "model unavailable",
    });
    expect(errorCode).toBe("opencode_exit_2");
  });

  it("prioritises signal over parsed error", () => {
    const { errorCode } = classifyOpenCodeFailure({
      ...base,
      exitCode: 0,
      signal: "SIGKILL",
      parsedError: "model unavailable",
    });
    expect(errorCode).toBe("opencode_signal_SIGKILL");
  });

  it("handles null adapterSessionId", () => {
    const { errorMeta } = classifyOpenCodeFailure({ ...base, exitCode: 1, signal: null, adapterSessionId: null });
    expect(errorMeta.adapterSessionId).toBeNull();
  });
});

describe("execute — transient statement error retry", () => {
  const TRANSIENT_STDERR = "Failed to execute statement / Unexpected server error";

  function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-transient",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        model: "router/coder",
        cwd: process.cwd(),
      },
      context: {},
      onLog: async () => {},
      ...overrides,
    };
  }

  function transientResult() {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: TRANSIENT_STDERR,
    };
  }

  function successResult() {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", part: { text: "Done", messageID: "msg-1" } }),
        JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 5, reasoning: 0 }, cost: 0 } }),
      ].join("\n"),
      stderr: "",
    };
  }

  beforeEach(() => {
    runAdapterExecutionTargetProcessMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a transient statement failure before any agent output", async () => {
    const retryLogs: string[] = [];
    runAdapterExecutionTargetProcessMock
      .mockImplementationOnce(async () => transientResult())
      .mockImplementationOnce(async () => transientResult())
      .mockImplementationOnce(async () => successResult());

    const ctx = makeCtx({
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        if (chunk.includes("transient opencode statement error")) retryLogs.push(chunk);
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(runAdapterExecutionTargetProcessMock).toHaveBeenCalledTimes(3);
    expect(retryLogs).toHaveLength(2);
    expect(retryLogs[0]).toContain("retry 1/2 after 500ms");
    expect(retryLogs[1]).toContain("retry 2/2 after 1500ms");
  }, 15000);

  it("terminates after exhausting retries on a persistent statement failure", async () => {
    runAdapterExecutionTargetProcessMock.mockImplementation(async () => transientResult());

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("opencode_statement_failed");
    expect(result.errorMessage).toContain(TRANSIENT_STDERR);
    expect(runAdapterExecutionTargetProcessMock).toHaveBeenCalledTimes(3);
  }, 15000);
});
