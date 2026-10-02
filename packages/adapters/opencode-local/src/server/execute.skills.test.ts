import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

function childEnvFor(runId: string): Record<string, string> {
  const call = runProcessMock.mock.calls.find((candidate) => candidate[0] === runId);
  if (!call) throw new Error(`no child process recorded for run ${runId}`);
  return call[4].env;
}

// The adapter removes the per-run HOME in a finally before `execute` returns,
// so the isolated home cannot be inspected after the run. Capture its contents
// from inside the mocked child launch instead — the exact moment the child
// would have read them.
async function captureHomeState(home: string): Promise<{
  skills: string[];
  skillsReal: Array<string | null>;
  claudeIsDir: boolean;
  gitconfigReal: string | null;
  dbReal: string | null;
  settingsReal: string | null;
  hasAgents: boolean;
}> {
  const realpathOrNull = async (p: string): Promise<string | null> =>
    fs.realpath(p).catch(() => null);
  const skillsLink = path.join(home, ".claude", "skills");
  const skills = await fs.readdir(skillsLink);
  return {
    skills,
    skillsReal: await Promise.all(skills.map((name) => realpathOrNull(path.join(skillsLink, name)))),
    claudeIsDir: (await fs.lstat(path.join(home, ".claude"))).isDirectory(),
    gitconfigReal: await realpathOrNull(path.join(home, ".gitconfig")),
    dbReal: await realpathOrNull(path.join(home, ".local", "share", "opencode", "opencode-agent-a.db")),
    settingsReal: await realpathOrNull(path.join(home, ".claude", "settings.json")),
    hasAgents: (await fs.lstat(path.join(home, ".agents")).then(() => true, () => false)),
  };
}

describe("OpenCode local skill injection", () => {
  it("injects runtime skills into the configured child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-configured-home",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
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
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const installedSkill = path.join(configuredHome, ".claude", "skills", "paperclip");
      expect((await fs.lstat(installedSkill)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(installedSkill)).toBe(await fs.realpath(skillSource));
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCode local skillIsolation=desired-only", () => {
  async function seedConfiguredHome(home: string) {
    await fs.writeFile(path.join(home, ".gitconfig"), "[user]\n\temail = agent@example.com\n", "utf8");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "settings.json"), "{\"theme\":\"dark\"}\n", "utf8");
    // .agents is opencode's other external skills location: it must NOT be
    // carried into the per-run home or the desired-only guarantee breaks.
    await fs.mkdir(path.join(home, ".agents", "skills", "rogue"), { recursive: true });
    await fs.writeFile(path.join(home, ".agents", "skills", "rogue", "SKILL.md"), "# rogue\n", "utf8");
    // opencode's data dir holds the per-agent session DB (relative OPENCODE_DB
    // is joined to $HOME/.local/share/opencode) and must stay the same real
    // location under the per-run home.
    await fs.mkdir(path.join(home, ".local", "share", "opencode"), { recursive: true });
    await fs.writeFile(path.join(home, ".local", "share", "opencode", "opencode-agent-a.db"), "db", "utf8");
  }

  function makeInput(overrides: {
    runId: string;
    agentId: string;
    config: Record<string, unknown>;
  }) {
    return {
      runId: overrides.runId,
      agent: {
        id: overrides.agentId,
        companyId: "company-1",
        name: "OpenCode Coder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: overrides.config,
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
    } as never;
  }

  it("exposes exactly the desired skills via a per-run HOME and leaves the shared home untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-desired-only-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(configuredHome, { recursive: true });
    await seedConfiguredHome(configuredHome);
    await fs.mkdir(processHome, { recursive: true });
    const skillAlpha = await createSkillDir(path.join(root, "src-alpha"), "alpha");
    const skillBeta = await createSkillDir(path.join(root, "src-beta"), "beta");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    let capturedHome: string | null = null;
    let capturedState: Awaited<ReturnType<typeof captureHomeState>> | null = null;
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      capturedHome = options.env.HOME;
      capturedState = await captureHomeState(capturedHome);
      return probeResult({
        stdout: JSON.stringify({
          type: "text",
          sessionID: "session-desired-only",
          part: { text: "done" },
        }),
      });
    });

    try {
      const result = await execute(makeInput({
        runId: "run-desired-only",
        agentId: "agent-desired-only",
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          skillIsolation: "desired-only",
          paperclipRuntimeSkills: [
            { key: "pc/alpha", runtimeName: "alpha", source: skillAlpha },
            { key: "pc/beta", runtimeName: "beta", source: skillBeta },
          ],
          paperclipSkillSync: { desiredSkills: ["pc/alpha"] },
          promptTemplate: "Do the thing.",
        },
      }));

      expect(result.exitCode).toBe(0);
      const isolatedHome = childEnvFor("run-desired-only").HOME;
      expect(isolatedHome).toBeTruthy();
      expect(isolatedHome).not.toBe(configuredHome);
      expect(isolatedHome).not.toBe(processHome);
      expect(capturedHome).toBe(isolatedHome);
      expect(capturedState).not.toBeNull();
      const state = capturedState!;

      // .claude is a real dir in the per-run home; its skills entry holds
      // exactly the desired skill.
      expect(state.claudeIsDir).toBe(true);
      expect(state.skills).toEqual(["alpha"]);
      expect(state.skillsReal[0]).toBe(await fs.realpath(skillAlpha));

      // HOME-dependent state carries over to the SAME real locations.
      expect(state.gitconfigReal).toBe(await fs.realpath(path.join(configuredHome, ".gitconfig")));
      expect(state.dbReal).toBe(
        await fs.realpath(path.join(configuredHome, ".local", "share", "opencode", "opencode-agent-a.db")),
      );
      expect(state.settingsReal).toBe(await fs.realpath(path.join(configuredHome, ".claude", "settings.json")));

      // .agents (the other external skills location) is not carried over.
      expect(state.hasAgents).toBe(false);

      // The shared skills home was never touched by this run.
      await expect(fs.lstat(path.join(configuredHome, ".claude", "skills"))).rejects.toThrow();

      // The per-run home is cleaned up after the run.
      await expect(fs.lstat(isolatedHome)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps concurrent desired-only runs of different agents isolated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-desired-concurrent-"));
    const processHome = path.join(root, "process-home");
    const sharedHome = path.join(root, "shared-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillOne = await createSkillDir(path.join(root, "src-one"), "one");
    const skillTwo = await createSkillDir(path.join(root, "src-two"), "two");
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.mkdir(processHome, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    const captured = new Map<string, Awaited<ReturnType<typeof captureHomeState>>>();
    runProcessMock.mockImplementation(async (runId: string, _target, _command, _args, options) => {
      captured.set(runId, await captureHomeState(options.env.HOME));
      return probeResult({
        stdout: JSON.stringify({
          type: "text",
          sessionID: `session-${runId}`,
          part: { text: "done" },
        }),
      });
    });

    const baseConfig = (desiredKey: string) => ({
      command: commandPath,
      cwd: workspace,
      model: "openai/gpt-5",
      env: {
        HOME: sharedHome,
        OPENCODE_ALLOW_ALL_MODELS: "1",
      },
      skillIsolation: "desired-only",
      paperclipRuntimeSkills: [
        { key: "pc/one", runtimeName: "one", source: skillOne },
        { key: "pc/two", runtimeName: "two", source: skillTwo },
      ],
      paperclipSkillSync: { desiredSkills: [desiredKey] },
      promptTemplate: "Do the thing.",
    });

    try {
      const [resultA, resultB] = await Promise.all([
        execute(makeInput({ runId: "run-conc-a", agentId: "agent-a", config: baseConfig("pc/one") })),
        execute(makeInput({ runId: "run-conc-b", agentId: "agent-b", config: baseConfig("pc/two") })),
      ]);
      expect(resultA.exitCode).toBe(0);
      expect(resultB.exitCode).toBe(0);

      const homeA = childEnvFor("run-conc-a").HOME;
      const homeB = childEnvFor("run-conc-b").HOME;
      expect(homeA).toBeTruthy();
      expect(homeB).toBeTruthy();
      expect(homeA).not.toBe(homeB);

      const stateA = captured.get("run-conc-a");
      const stateB = captured.get("run-conc-b");
      expect(stateA).toBeDefined();
      expect(stateB).toBeDefined();
      expect(stateA!.skills).toEqual(["one"]);
      expect(stateA!.skillsReal[0]).toBe(await fs.realpath(skillOne));
      expect(stateB!.skills).toEqual(["two"]);
      expect(stateB!.skillsReal[0]).toBe(await fs.realpath(skillTwo));

      // Neither run may have injected into the shared home.
      await expect(fs.lstat(path.join(sharedHome, ".claude", "skills"))).rejects.toThrow();
      // Both per-run homes are cleaned up.
      await expect(fs.lstat(homeA)).rejects.toThrow();
      await expect(fs.lstat(homeB)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the child HOME on the configured home when skillIsolation is not set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-shared-default-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillAlpha = await createSkillDir(path.join(root, "src-alpha"), "alpha");
    const skillBeta = await createSkillDir(path.join(root, "src-beta"), "beta");
    await fs.mkdir(configuredHome, { recursive: true });
    await fs.mkdir(processHome, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-shared-default",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute(makeInput({
        runId: "run-shared-default",
        agentId: "agent-shared",
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [
            { key: "pc/alpha", runtimeName: "alpha", source: skillAlpha },
            { key: "pc/beta", runtimeName: "beta", source: skillBeta },
          ],
          paperclipSkillSync: { desiredSkills: ["pc/alpha"] },
          promptTemplate: "Do the thing.",
        },
      }));

      expect(result.exitCode).toBe(0);
      // Default shared mode: the child keeps the configured HOME and the
      // desired skill is injected into the shared skills home as before.
      expect(childEnvFor("run-shared-default").HOME).toBe(configuredHome);
      const injected = path.join(configuredHome, ".claude", "skills", "alpha");
      expect((await fs.lstat(injected)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(injected)).toBe(await fs.realpath(skillAlpha));
      await expect(fs.lstat(path.join(configuredHome, ".claude", "skills", "beta"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCode local exposure line names the exposed skills", () => {
  async function runAndCaptureLogs(input: {
    root: string;
    runId: string;
    configuredHome: string;
    extraConfig: Record<string, unknown>;
  }): Promise<string[]> {
    const workspace = path.join(input.root, "workspace");
    const commandPath = path.join(input.root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({ type: "text", sessionID: `session-${input.runId}`, part: { text: "done" } }),
    }));
    const logs: string[] = [];
    const result = await execute({
      runId: input.runId,
      agent: {
        id: "agent-exposure",
        companyId: "company-1",
        name: "OpenCode Coder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: workspace,
        model: "openai/gpt-5",
        env: { HOME: input.configuredHome, OPENCODE_ALLOW_ALL_MODELS: "1" },
        promptTemplate: "Do the thing.",
        ...input.extraConfig,
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);
    expect(result.exitCode).toBe(0);
    return logs;
  }

  function exposureLines(logs: string[]): string[] {
    return logs.filter((chunk) => chunk.startsWith("[paperclip] skillIsolation=") && chunk.includes(" run exposes "));
  }

  it("(4) lists every entry of the shared skills home, peers' links and real directories included", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-exposure-shared-"));
    const configuredHome = path.join(root, "configured-home");
    const skillsHome = path.join(configuredHome, ".claude", "skills");
    const skillAlpha = await createSkillDir(path.join(root, "src-alpha"), "alpha");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(await createSkillDir(path.join(root, "src-peer"), "peer"), path.join(skillsHome, "peer"));
    await createSkillDir(skillsHome, "real-dir-skill");
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(root, "process-home");
    try {
      const logs = await runAndCaptureLogs({
        root,
        runId: "run-exposure-shared",
        configuredHome,
        extraConfig: {
          paperclipRuntimeSkills: [{ key: "pc/alpha", runtimeName: "alpha", source: skillAlpha }],
          paperclipSkillSync: { desiredSkills: ["pc/alpha"] },
        },
      });
      expect(exposureLines(logs)).toEqual([
        `[paperclip] skillIsolation=shared: run exposes 3 skill(s) via shared skills home ${skillsHome} names=alpha,peer,real-dir-skill\n`,
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("(4b) lists only the desired skills for a desired-only run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-exposure-desired-"));
    const configuredHome = path.join(root, "configured-home");
    const skillAlpha = await createSkillDir(path.join(root, "src-alpha"), "alpha");
    const skillBeta = await createSkillDir(path.join(root, "src-beta"), "beta");
    await fs.mkdir(path.join(configuredHome, ".claude", "skills"), { recursive: true });
    await fs.symlink(skillBeta, path.join(configuredHome, ".claude", "skills", "beta"));
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(root, "process-home");
    try {
      const logs = await runAndCaptureLogs({
        root,
        runId: "run-exposure-desired",
        configuredHome,
        extraConfig: {
          skillIsolation: "desired-only",
          paperclipRuntimeSkills: [
            { key: "pc/alpha", runtimeName: "alpha", source: skillAlpha },
            { key: "pc/beta", runtimeName: "beta", source: skillBeta },
          ],
          paperclipSkillSync: { desiredSkills: ["pc/alpha"] },
        },
      });
      const isolatedHome = childEnvFor("run-exposure-desired").HOME;
      expect(exposureLines(logs)).toEqual([
        `[paperclip] skillIsolation=desired-only: run exposes 1 skill(s) via per-run HOME ${isolatedHome} names=alpha\n`,
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // chmod cannot hide a directory from root, so this case runs only as a normal user.
  it.skipIf(process.getuid?.() === 0)("(4c) prints an empty list when the shared skills home cannot be read", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-exposure-unreadable-"));
    const configuredHome = path.join(root, "configured-home");
    const skillsHome = path.join(configuredHome, ".claude", "skills");
    await createSkillDir(skillsHome, "real-dir-skill");
    await fs.chmod(skillsHome, 0o000);
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(root, "process-home");
    try {
      const logs = await runAndCaptureLogs({
        root,
        runId: "run-exposure-unreadable",
        configuredHome,
        extraConfig: {
          paperclipRuntimeSkills: [],
          paperclipSkillSync: { desiredSkills: [] },
        },
      });
      expect(exposureLines(logs)).toEqual([
        `[paperclip] skillIsolation=shared: run exposes 0 skill(s) via shared skills home ${skillsHome} names=\n`,
      ]);
    } finally {
      await fs.chmod(skillsHome, 0o755);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
