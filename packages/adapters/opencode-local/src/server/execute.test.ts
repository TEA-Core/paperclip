import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcessMock, ensureCommandResolvableMock } = vi.hoisted(() => ({
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
import { runningProcesses, sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

import {
  buildOpenCodeFailureLogLine,
  buildOpenCodeRunArgs,
  classifyOpenCodeFailure,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  execute,
  resolveOpenCodeDatabaseFile,
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

// SUP-13963: a failure that records a non-null errorCode used to leave no
// trace in the container log — stderrTail was captured into the run record but
// nothing was emitted, so the next occurrence was an elimination exercise. The
// line below is that trace: one structured line per failed run, scrubbed
// through the repo's secret-redaction helper, stable enough to grep.
describe("buildOpenCodeFailureLogLine", () => {
  it("builds a single-line payload carrying errorCode, adapterSessionId, and stderrTail", () => {
    const line = buildOpenCodeFailureLogLine({
      runId: "run-13963",
      errorCode: "opencode_exit_1",
      errorMeta: {
        adapterSessionId: "ses_abc",
        stderrTail: "Error: Unexpected error\nEACCES: permission denied",
      },
    });
    expect(typeof line).toBe("string");
    const text = line as string;
    // A multi-line tail must stay on one physical line (escaped in the JSON).
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    const payload = JSON.parse(text.replace(/^\[paperclip\] /, "")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "opencode_adapter_failure",
      runId: "run-13963",
      errorCode: "opencode_exit_1",
      adapterSessionId: "ses_abc",
    });
    expect(payload.stderrTail).toBe("Error: Unexpected error\nEACCES: permission denied");
  });

  it("emits nothing for a clean run (null errorCode)", () => {
    expect(
      buildOpenCodeFailureLogLine({
        runId: "run-13963",
        errorCode: null,
        errorMeta: { adapterSessionId: "ses_abc", stderrTail: "" },
      }),
    ).toBeNull();
  });

  it("redacts secret-shaped values out of stderrTail before emission", () => {
    const secret = "sk-testsecret12345678901";
    const line = buildOpenCodeFailureLogLine({
      runId: "run-13963",
      errorCode: "opencode_exit_1",
      errorMeta: {
        adapterSessionId: "ses_abc",
        stderrTail: `Error: request failed Authorization: Bearer ${secret}`,
      },
    });
    expect(line).not.toBeNull();
    expect(line).not.toContain(secret);
    expect(line).toContain("***REDACTED***");
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

// SUP-13963: a non-zero-exit adapter failure must leave exactly one structured
// line in the container log carrying errorCode, adapterSessionId, and the
// redacted stderrTail — the trace that turns the next occurrence into a grep
// instead of an elimination exercise.
describe("execute — SUP-13963 failure log line", () => {
  const FAILURE_STDERR = "Error: Unexpected error";
  const SEED_SECRET = "sk-testsecret12345678901";

  function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-faillog",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "ses_faillog",
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { model: "router/coder", cwd: process.cwd() },
      context: {},
      onLog: async () => {},
      ...overrides,
    };
  }

  function failureResult() {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: `${FAILURE_STDERR}\nAuthorization: Bearer ${SEED_SECRET}`,
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

  it("emits exactly one structured line carrying errorCode, adapterSessionId, and the redacted stderrTail", async () => {
    const logs: string[] = [];
    runAdapterExecutionTargetProcessMock.mockImplementation(async () => failureResult());

    const result = await execute(
      makeCtx({
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => void logs.push(chunk),
      }),
    );

    expect(result.errorCode).toBe("opencode_exit_1");
    const failureLines = logs.filter((chunk) => chunk.includes("opencode_adapter_failure"));
    expect(failureLines).toHaveLength(1);
    const payload = JSON.parse(failureLines[0].trimEnd().replace(/^\[paperclip\] /, "")) as Record<string, unknown>;
    expect(payload.errorCode).toBe("opencode_exit_1");
    expect(payload.adapterSessionId).toBe("ses_faillog");
    expect(String(payload.stderrTail)).toContain(FAILURE_STDERR);
    // The seeded secret-shaped value must not survive into the emitted line.
    expect(failureLines[0]).not.toContain(SEED_SECRET);
    expect(failureLines[0]).toContain("***REDACTED***");
    // One physical line per failure, even with a multi-line tail.
    expect(failureLines[0].trimEnd().split("\n")).toHaveLength(1);
  });

  it("emits no failure line for a clean run", async () => {
    const logs: string[] = [];
    runAdapterExecutionTargetProcessMock.mockImplementation(async () => successResult());

    const result = await execute(
      makeCtx({
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => void logs.push(chunk),
      }),
    );

    expect(result.errorCode ?? null).toBeNull();
    expect(logs.some((chunk) => chunk.includes("opencode_adapter_failure"))).toBe(false);
  });
});

// SUP-10914: every opencode_local run wrote to ONE shared SQLite database
// (`<opencode data dir>/opencode.db`), so a single runaway message held the
// only write lock and every other agent's write blew opencode's 5s busy
// timeout — 63 `adapter_failed` in one hour across 7 agents. Giving each agent
// its own database file keeps a bad run's blast radius inside that agent.
describe("resolveOpenCodeDatabaseFile", () => {
  const emptyProcessEnv: NodeJS.ProcessEnv = {};

  it("derives a stable per-agent database filename", () => {
    expect(
      resolveOpenCodeDatabaseFile({
        agentId: "0e61ff36-2135-408f-ab12-360ed3e7702d",
        env: {},
        processEnv: emptyProcessEnv,
      }),
    ).toBe("opencode-agent-0e61ff36-2135-408f-ab12-360ed3e7702d.db");
  });

  it("returns a relative filename so opencode keeps resolving it inside its own data dir", () => {
    const file = resolveOpenCodeDatabaseFile({
      agentId: "agent-1",
      env: {},
      processEnv: emptyProcessEnv,
    });
    expect(file?.startsWith("/")).toBe(false);
  });

  it("sanitises characters that are not safe in a filename", () => {
    expect(
      resolveOpenCodeDatabaseFile({
        agentId: "../../etc/pas swd",
        env: {},
        processEnv: emptyProcessEnv,
      }),
    ).toBe("opencode-agent-..-..-etc-pas-swd.db");
  });

  it("never overrides an explicitly configured OPENCODE_DB from the run env", () => {
    expect(
      resolveOpenCodeDatabaseFile({
        agentId: "agent-1",
        env: { OPENCODE_DB: "custom.db" },
        processEnv: emptyProcessEnv,
      }),
    ).toBeNull();
  });

  it("never overrides an explicitly configured OPENCODE_DB from the process env", () => {
    expect(
      resolveOpenCodeDatabaseFile({
        agentId: "agent-1",
        env: {},
        processEnv: { OPENCODE_DB: "custom.db" },
      }),
    ).toBeNull();
  });

  it("falls back to the shared database when PAPERCLIP_OPENCODE_SHARED_DB is set", () => {
    expect(
      resolveOpenCodeDatabaseFile({
        agentId: "agent-1",
        env: { PAPERCLIP_OPENCODE_SHARED_DB: "1" },
        processEnv: emptyProcessEnv,
      }),
    ).toBeNull();
  });

  it("falls back to the shared database when the agent has no id", () => {
    expect(
      resolveOpenCodeDatabaseFile({ agentId: "  ", env: {}, processEnv: emptyProcessEnv }),
    ).toBeNull();
  });
});

describe("execute — per-agent opencode database", () => {
  function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-db",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { model: "router/coder", cwd: process.cwd() },
      context: {},
      onLog: async () => {},
      ...overrides,
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

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_DB;
  });

  it("points the run at the agent's own database file", async () => {
    await execute(makeCtx());
    const call = runAdapterExecutionTargetProcessMock.mock.calls.at(-1);
    expect(call?.[4].env.OPENCODE_DB).toBe("opencode-agent-agent-1.db");
  });

  it("keeps an operator-configured OPENCODE_DB from adapterConfig.env", async () => {
    await execute(
      makeCtx({ config: { model: "router/coder", cwd: process.cwd(), env: { OPENCODE_DB: "shared.db" } } }),
    );
    const call = runAdapterExecutionTargetProcessMock.mock.calls.at(-1);
    expect(call?.[4].env.OPENCODE_DB).toBe("shared.db");
  });
});

// SUP-10914: per-agent databases stop a runaway run from failing OTHER agents,
// but nothing stops it destroying its own — the fix for that (bound the message
// row, emit deltas instead of per-delta full snapshots) is inside opencode and
// unreachable from here. The guard watches the only thing the adapter can see:
// the database and its WAL gaining hundreds of megabytes inside one run.
describe("execute — opencode database growth guard", () => {
  const TRANSIENT_STDERR = "Failed to execute statement / Unexpected server error";
  const cleanupPaths = new Set<string>();

  async function makeDataHome() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-guard-"));
    cleanupPaths.add(root);
    await fs.mkdir(path.join(root, "opencode"), { recursive: true });
    return root;
  }

  function makeCtx(config: Record<string, unknown>, overrides: Partial<AdapterExecutionContext> = {}) {
    return {
      runId: "run-guard",
      agent: {
        id: "agent-guard",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { model: "router/coder", cwd: process.cwd(), ...config },
      context: {},
      onLog: async () => {},
      ...overrides,
    } as AdapterExecutionContext;
  }

  function guardEnv(dataHome: string, extra: Record<string, string> = {}) {
    return {
      XDG_DATA_HOME: dataHome,
      PAPERCLIP_OPENCODE_DB_GROWTH_LIMIT_MB: "1",
      PAPERCLIP_OPENCODE_DB_GROWTH_POLL_SEC: "1",
      ...extra,
    };
  }

  /**
   * Stand in for a runaway run: the process writes far past the budget and keeps
   * running, exactly as the 431 MB message did, and only exits once the guard
   * has had time to notice and signal it.
   */
  function runawayProcess(databasePath: string, stderr = "") {
    return async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(4 * 1024 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return { exitCode: null, signal: "SIGTERM", timedOut: false, stdout: "", stderr };
    };
  }

  beforeEach(() => {
    runAdapterExecutionTargetProcessMock.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      [...cleanupPaths].map(async (filepath) => {
        await fs.rm(filepath, { recursive: true, force: true });
        cleanupPaths.delete(filepath);
      }),
    );
  });

  it("fails a runaway run under its own error code", async () => {
    const dataHome = await makeDataHome();
    const databasePath = path.join(dataHome, "opencode", "opencode-agent-agent-guard.db");
    runAdapterExecutionTargetProcessMock.mockImplementation(runawayProcess(databasePath));

    const logs: string[] = [];
    const result = await execute(
      makeCtx(
        { env: guardEnv(dataHome) },
        { onLog: async (_stream: "stdout" | "stderr", chunk: string) => void logs.push(chunk) },
      ),
    );

    expect(result.errorCode).toBe("opencode_db_growth_limit");
    // SIGTERM leaves no exit code; without synthesis this would read as a success.
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("OpenCode database grew");
    expect(logs.some((line) => line.includes("OpenCode database grew"))).toBe(true);
    const growth = (result.errorMeta as { databaseGrowth?: { growthBytes?: number } } | undefined)
      ?.databaseGrowth;
    expect(growth?.growthBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  }, 20000);

  // Terminating the run is the whole point: without the signal the guard just
  // annotates a run that keeps writing.
  it("signals the running process so the runaway actually stops writing", async () => {
    const dataHome = await makeDataHome();
    const databasePath = path.join(dataHome, "opencode", "opencode-agent-agent-guard.db");
    runAdapterExecutionTargetProcessMock.mockImplementation(runawayProcess(databasePath));

    const kill = vi.fn();
    runningProcesses.set("run-guard", {
      child: { exitCode: null, signalCode: null, kill },
      processGroupId: 0,
    } as unknown as NonNullable<ReturnType<typeof runningProcesses.get>>);

    try {
      await execute(makeCtx({ env: guardEnv(dataHome) }));
    } finally {
      runningProcesses.delete("run-guard");
    }

    expect(kill).toHaveBeenCalledWith("SIGTERM");
  }, 20000);

  // The transient-statement retry exists for lock errors — which a runaway run
  // plausibly emits. Retrying one would replay the same message and write the
  // same bytes again, so the guard has to win.
  it("never retries a run it killed, even when the run also looks transient", async () => {
    const dataHome = await makeDataHome();
    const databasePath = path.join(dataHome, "opencode", "opencode-agent-agent-guard.db");
    runAdapterExecutionTargetProcessMock.mockImplementation(
      runawayProcess(databasePath, TRANSIENT_STDERR),
    );

    const result = await execute(makeCtx({ env: guardEnv(dataHome) }));

    expect(result.errorCode).toBe("opencode_db_growth_limit");
    expect(runAdapterExecutionTargetProcessMock).toHaveBeenCalledTimes(1);
  }, 20000);

  it("lets a run that stays inside its budget finish normally", async () => {
    const dataHome = await makeDataHome();
    const databasePath = path.join(dataHome, "opencode", "opencode-agent-agent-guard.db");
    runAdapterExecutionTargetProcessMock.mockImplementation(async () => {
      await fs.writeFile(databasePath, Buffer.alloc(64 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    });

    const result = await execute(makeCtx({ env: guardEnv(dataHome) }));

    expect(result.errorCode ?? null).toBeNull();
    expect(result.exitCode).toBe(0);
  }, 20000);

  it("records that the guard is armed in the run's command notes", async () => {
    const dataHome = await makeDataHome();
    runAdapterExecutionTargetProcessMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }));

    let commandNotes: string[] = [];
    await execute(
      makeCtx(
        { env: guardEnv(dataHome) },
        { onMeta: async (meta: { commandNotes?: string[] }) => void (commandNotes = meta.commandNotes ?? []) },
      ),
    );

    expect(commandNotes.some((note) => note.includes("database growth guard"))).toBe(true);
    // SUP-11268: the note must state on what basis the measured growth is
    // attributed to this run, not just that the guard is on.
    expect(commandNotes.some((note) => note.includes("Attribution basis"))).toBe(true);
    expect(commandNotes.some((note) => note.includes("per-session accounting"))).toBe(true);
  });

  // On the shared database the growth we would measure may belong to a
  // different agent's run. Killing this run for someone else's writes would be
  // worse than the leak, so the guard stays disarmed.
  it("stays disarmed on a shared database", async () => {
    const dataHome = await makeDataHome();
    runAdapterExecutionTargetProcessMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }));

    let commandNotes: string[] = [];
    await execute(
      makeCtx(
        { env: guardEnv(dataHome, { PAPERCLIP_OPENCODE_SHARED_DB: "1" }) },
        { onMeta: async (meta: { commandNotes?: string[] }) => void (commandNotes = meta.commandNotes ?? []) },
      ),
    );

    expect(commandNotes.some((note) => note.includes("database growth guard"))).toBe(false);
  });

  it("stays disarmed when an operator opts out with a zero budget", async () => {
    const dataHome = await makeDataHome();
    const databasePath = path.join(dataHome, "opencode", "opencode-agent-agent-guard.db");
    runAdapterExecutionTargetProcessMock.mockImplementation(runawayProcess(databasePath));

    const result = await execute(
      makeCtx({ env: guardEnv(dataHome, { PAPERCLIP_OPENCODE_DB_GROWTH_LIMIT_MB: "0" }) }),
    );

    expect(result.errorCode).not.toBe("opencode_db_growth_limit");
  }, 20000);
});

describe("execute — sanitizeInheritedPaperclipEnv at spawn points", () => {
  function makeCtx(): AdapterExecutionContext {
    return {
      runId: "run-sanitize",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { model: "router/coder", cwd: process.cwd() },
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

  afterEach(() => {
    vi.restoreAllMocks();
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
