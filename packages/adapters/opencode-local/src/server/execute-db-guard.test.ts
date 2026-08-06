import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  parseOpenCodeModelsOutput: () => [],
  requireOpenCodeModelId: (model: unknown) => {
    const s = typeof model === "string" ? model.trim() : "";
    if (!s || !s.includes("/")) {
      throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
    }
    return s;
  },
}));

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";

const cleanupPaths = new Set<string>();

async function makeDataHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-guard-test-"));
  await fs.mkdir(path.join(dir, "opencode"), { recursive: true });
  cleanupPaths.add(dir);
  return dir;
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
 * An opencode database with the two tables the guard's attribution query reads.
 * The real schema is what makes this test honest: a mismatch would make
 * `measureOpenCodeSessionBytes` return null and both runs would be terminated.
 */
async function makeOpenCodeDatabase(databasePath: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE event (
      id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL,
      type text NOT NULL, data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
  `);
  db.close();
}

async function writeRunawayEvents(databasePath: string, sessionId: string, bytes: number) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("INSERT INTO event VALUES (?, ?, ?, ?, ?)").run(
      `e-${sessionId}`,
      sessionId,
      1,
      "message.part.updated.1",
      "x".repeat(bytes),
    );
  } finally {
    db.close();
  }
}

beforeEach(() => {
  runAdapterExecutionTargetProcessMock.mockReset();
  delete process.env.OPENCODE_DB;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OPENCODE_DB;
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

// SUP-11268: one agent runs several issues at once, and they all write to that
// agent's single opencode database, so the file-total guard killed every
// concurrent run for one runaway's bytes. A per-run database file would isolate
// them, but opencode keeps its sessions in that file and a fresh one per run
// would break every cross-run `--session` resume; attribution (SUP-11280) is
// what makes the guard honest instead. The single-run guard behaviours (trip,
// signal, notes, disarm) are covered in execute.test.ts; this file covers the
// concurrency property end to end, through execute() and the real sqlite query.
describe("database growth guard concurrency", () => {
  it("kills only the run whose own session owns the growth, and lets its sibling finish", async () => {
    const dataHome = await makeDataHome();
    const agentId = "agent-shared";
    const databasePath = path.join(dataHome, "opencode", `opencode-agent-${agentId}.db`);
    await makeOpenCodeDatabase(databasePath);

    const runawaySessionId = "ses_runaway000000000000000";
    const innocentSessionId = "ses_innocent0000000000000";

    const ctxA = makeCtx({ env: guardEnv(dataHome) }, { runId: "run-a" });
    ctxA.agent.id = agentId;
    const ctxB = makeCtx({ env: guardEnv(dataHome) }, { runId: "run-b" });
    ctxB.agent.id = agentId;

    let bCompleted = false;
    runAdapterExecutionTargetProcessMock.mockImplementation(
      async (
        runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        options: { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> },
      ) => {
        // Both runs announce their session on stdout, which is how the guard
        // learns whose writes to charge.
        const sessionId = runId === "run-a" ? runawaySessionId : innocentSessionId;
        const stdout = `{"type":"text","sessionID":"${sessionId}","part":{}}\n`;
        await options.onLog("stdout", stdout);
        if (runId === "run-a") {
          // Written after the guard has baselined the file and the session.
          await new Promise((resolve) => setTimeout(resolve, 1200));
          await writeRunawayEvents(databasePath, runawaySessionId, 4 * 1024 * 1024);
          await new Promise((resolve) => setTimeout(resolve, 2500));
          return { exitCode: null, signal: "SIGTERM", timedOut: false, stdout, stderr: "" };
        }
        // The innocent run writes nothing of its own and outlives the trip.
        await new Promise((resolve) => setTimeout(resolve, 4500));
        bCompleted = true;
        return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
      },
    );

    const killA = vi.fn();
    const killB = vi.fn();
    runningProcesses.set("run-a", {
      child: { exitCode: null, signalCode: null, kill: killA },
      processGroupId: 0,
    } as unknown as NonNullable<ReturnType<typeof runningProcesses.get>>);
    runningProcesses.set("run-b", {
      child: { exitCode: null, signalCode: null, kill: killB },
      processGroupId: 0,
    } as unknown as NonNullable<ReturnType<typeof runningProcesses.get>>);

    try {
      const [resultA, resultB] = await Promise.all([execute(ctxA), execute(ctxB)]);

      expect(resultA.errorCode).toBe("opencode_db_growth_limit");
      expect(resultA.exitCode).toBe(1);
      expect(resultA.errorMessage).toContain(runawaySessionId);
      expect(killA).toHaveBeenCalledWith("SIGTERM");

      expect(resultB.errorCode ?? null).toBeNull();
      expect(resultB.exitCode).toBe(0);
      expect(killB).not.toHaveBeenCalled();
      expect(bCompleted).toBe(true);
    } finally {
      runningProcesses.delete("run-a");
      runningProcesses.delete("run-b");
    }
  }, 30000);
});
