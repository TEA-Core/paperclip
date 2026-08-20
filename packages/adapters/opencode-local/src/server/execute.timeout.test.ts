import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TIMED_OUT_STDOUT = [
  JSON.stringify({ type: "step_start", sessionID: "session_mid_turn" }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "session_mid_turn",
    part: { cost: 0.25, tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 50, write: 0 } } },
  }),
  // No terminal result: the process was SIGTERMed while the next turn was in flight.
].join("\n");

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
    stdout: TIMED_OUT_STDOUT,
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "opencode"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

vi.mock("./models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models.js")>()),
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(async () => undefined),
}));

import { execute } from "./execute.js";

async function runTimedOutExecution(overrides: { sessionId?: string | null; timeoutSec?: number } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-timeout-"));
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const result = await execute({
    runId: "run-timeout-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenCode Builder",
      adapterType: "opencode_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: overrides.sessionId ?? null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "opencode",
      model: "opencode/gpt-5-nano",
      timeoutSec: overrides.timeoutSec ?? 5400,
    },
    context: {
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
    },
    onLog: async () => {},
  });
  return { result, rootDir, workspaceDir };
}

describe("opencode timeout handling", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps the session so the next run resumes instead of restarting cold", async () => {
    const { result, rootDir, workspaceDir } = await runTimedOutExecution();
    cleanupDirs.push(rootDir);

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe("session_mid_turn");
    expect(result.sessionDisplayId).toBe("session_mid_turn");
    expect(result.sessionParams).toMatchObject({
      sessionId: "session_mid_turn",
      cwd: workspaceDir,
    });
    expect(result.clearSession).toBe(false);
  });

  it("reports the tokens the killed run actually spent", async () => {
    const { result, rootDir } = await runTimedOutExecution();
    cleanupDirs.push(rootDir);

    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 100, cachedInputTokens: 50 });
    expect(result.costUsd).toBeCloseTo(0.25, 5);
  });

  it("still reports the timeout as the failure", async () => {
    const { result, rootDir } = await runTimedOutExecution({ timeoutSec: 5400 });
    cleanupDirs.push(rootDir);

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toBe("Timed out after 5400s");
  });

  it("gives the run its deadline through both the env and the prompt", async () => {
    const { result, rootDir } = await runTimedOutExecution({ timeoutSec: 5400 });
    cleanupDirs.push(rootDir);
    expect(result.timedOut).toBe(true);

    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; stdin?: string }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_RUN_TIMEOUT_SEC).toBe("5400");
    expect(Number(call?.[3].env.PAPERCLIP_RUN_DEADLINE_EPOCH)).toBeGreaterThan(Date.now() / 1000);
    expect(call?.[3].stdin).toContain("Run time budget");
    expect(call?.[3].stdin).toContain("PAPERCLIP_RUN_DEADLINE_EPOCH");
  });

  it("says nothing about a deadline when the run is unbounded", async () => {
    const { result, rootDir } = await runTimedOutExecution({ timeoutSec: 0 });
    cleanupDirs.push(rootDir);
    expect(result.timedOut).toBe(true);

    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; stdin?: string }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_RUN_DEADLINE_EPOCH).toBeUndefined();
    expect(call?.[3].stdin).not.toContain("Run time budget");
  });
});
