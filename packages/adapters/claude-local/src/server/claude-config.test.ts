import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAgentSideClaudeConfigPath,
  normalizeClaudeConfigDirTree,
  prepareClaudeConfigSeed,
  seedAgentSideClaudeConfig,
} from "./claude-config.js";
import { runClaudeConfigNormalizerCli } from "./claude-config-normalize.js";

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("seedAgentSideClaudeConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  function agentSideHome(root: string): string {
    return path.join(
      root,
      "paperclip-home",
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "claude-config",
    );
  }

  it("does not pre-create SDK subdirs when the lane is armed, but keeps the home root and credential files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-armed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, ".credentials.json"),
      JSON.stringify({ token: "local" }),
      "utf8",
    );

    const onLog = vi.fn(async () => {});
    await seedAgentSideClaudeConfig(createEnv(root, sourceDir), onLog, "company-1", "agent-1", {
      skipSdkSubdirs: true,
    });

    const configDir = agentSideHome(root);
    expect((await fs.stat(configDir)).mode & 0o7777).toBe(0o2770);
    await expect(fs.readFile(path.join(configDir, ".credentials.json"), "utf8")).resolves.toBe(
      JSON.stringify({ token: "local" }),
    );
    // The SDK subdirs are left for the agent uid to create and own.
    for (const subdir of ["projects", "session-env", "sessions", "shell-snapshots", "statsig"]) {
      await expect(fs.access(path.join(configDir, subdir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("logs and survives a chmod EPERM on a pre-created SDK subdir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-eperm-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    const onLog = vi.fn(async (_stream?: "stdout" | "stderr", _message?: string) => {});
    const env = createEnv(root, sourceDir);
    await seedAgentSideClaudeConfig(env, onLog, "company-1", "agent-1");

    const configDir = agentSideHome(root);
    const sessionsDir = path.join(configDir, "sessions");
    const realChmod = fs.chmod.bind(fs);
    const eperm = Object.assign(new Error("chmod sessions EPERM"), { code: "EPERM" });
    vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      if (String(target).endsWith(path.join("sessions"))) {
        return Promise.reject(eperm);
      }
      return realChmod(target, mode);
    });

    // Must NOT reject: the subdir fault degrades to the run-end re-normalize.
    await expect(seedAgentSideClaudeConfig(env, onLog, "company-1", "agent-1")).resolves.toBe(
      undefined,
    );
    const stderrLines = onLog.mock.calls
      .filter((call) => call[0] === "stderr")
      .map((call) => String(call[1]));
    expect(
      stderrLines.some((line) => line.includes(sessionsDir) && line.includes("chmod sessions EPERM")),
    ).toBe(true);
    // The skip is scoped to the failed dir: the other subdirs are still enforced.
    expect((await fs.stat(path.join(configDir, "projects"))).mode & 0o7777).toBe(0o2770);
  });
});

describe("normalizeClaudeConfigDirTree", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("recurses through a dir owned by another uid without chmodding it and without logging", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-foreign-"));
    cleanupDirs.push(root);
    const foreignDir = path.join(root, "sessions");
    const innerDir = path.join(foreignDir, "inner");
    await fs.mkdir(innerDir, { recursive: true });
    await fs.chmod(foreignDir, 0o700);
    await fs.chmod(innerDir, 0o700);

    const realStat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
      const out = await realStat(target, ...rest);
      if (String(target).endsWith(path.join("sessions"))) {
        return Object.assign(out, { uid: 999_999_999 });
      }
      return out;
    });
    vi.spyOn(fs, "chown").mockResolvedValue(undefined);

    const onLog = vi.fn(async () => {});
    await normalizeClaudeConfigDirTree(root, onLog);

    // The foreign-owned dir keeps its mode (the pass leaves it to the other uid)...
    expect((await fs.stat(foreignDir)).mode & 0o7777).toBe(0o700);
    // ...but still recursed through it and fixed the owned child...
    expect((await fs.stat(innerDir)).mode & 0o7777).toBe(0o2770);
    // ...and produced no log noise at all.
    expect(onLog).not.toHaveBeenCalled();
  });

  it("never follows a symlink out of the tree", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-out-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-home-"));
    cleanupDirs.push(outside, home);
    await fs.chmod(outside, 0o700);
    await fs.symlink(outside, path.join(home, "escape"));

    const onLog = vi.fn(async () => {});
    await normalizeClaudeConfigDirTree(home, onLog);

    // The link target keeps its owner-only mode — the walk never reached it.
    expect((await fs.stat(outside)).mode & 0o7777).toBe(0o700);
    // The link itself was left untouched.
    expect((await fs.lstat(path.join(home, "escape"))).isSymbolicLink()).toBe(true);
  });
});

describe("isAgentSideClaudeConfigPath", () => {
  const root = path.join(os.tmpdir(), "paperclip-claude-config-shape-root");
  const env: NodeJS.ProcessEnv = {
    PAPERCLIP_HOME: path.join(root, "paperclip-home"),
    PAPERCLIP_INSTANCE_ID: "test-instance",
  };
  const instanceRoot = path.join(root, "paperclip-home", "instances", "test-instance");

  it("accepts exactly <instanceRoot>/companies/<companyId>/agents/<agentId>/claude-config", () => {
    expect(
      isAgentSideClaudeConfigPath(
        path.join(instanceRoot, "companies", "company-1", "agents", "agent-1", "claude-config"),
        env,
      ),
    ).toBe(true);
    // A trailing slash resolves onto the same canonical path.
    expect(
      isAgentSideClaudeConfigPath(
        path.join(instanceRoot, "companies", "company-1", "agents", "agent-1", "claude-config") +
          path.sep,
        env,
      ),
    ).toBe(true);
  });

  it("refuses out-of-shape targets", () => {
    const refused = [
      "",
      "   ",
      "/tmp/claude-config",
      path.join(root, "claude-config"),
      path.join(
        instanceRoot,
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "claude-runtime",
      ),
      path.join(
        instanceRoot,
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "claude-config",
        "projects",
      ),
      path.join(
        instanceRoot,
        "companies",
        "a/b",
        "agents",
        "agent-1",
        "claude-config",
      ),
      path.join(
        instanceRoot,
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "..",
        "..",
        "claude-config",
      ),
    ];
    for (const target of refused) {
      expect(isAgentSideClaudeConfigPath(target, env)).toBe(false);
    }
  });
});

describe("runClaudeConfigNormalizerCli", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string): NodeJS.ProcessEnv {
    return {
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
    };
  }

  it("rejects an out-of-shape path argument without touching the filesystem", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-normalize-argv-"));
    cleanupDirs.push(root);
    const env = createEnv(root);
    const instanceRoot = path.join(root, "paperclip-home", "instances", "test-instance");
    const targets = [
      "/tmp/claude-config",
      path.join(
        instanceRoot,
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "claude-runtime",
      ),
      path.join(
        instanceRoot,
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "claude-config",
        "projects",
      ),
    ];
    for (const target of targets) {
      await expect(
        runClaudeConfigNormalizerCli({
          argv: ["node", "claude-config-normalize.js", target],
          env,
        }),
      ).resolves.toBe(2);
    }
    // Refused targets were never created or modified.
    await expect(
      fs.access(path.join(instanceRoot, "companies", "company-1", "agents", "agent-1", "claude-runtime")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes an in-shape target and returns 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-normalize-run-"));
    cleanupDirs.push(root);
    const env = createEnv(root);
    const configDir = path.join(
      root,
      "paperclip-home",
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "claude-config",
    );
    await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
    await fs.chmod(configDir, 0o700);
    await fs.chmod(path.join(configDir, "sessions"), 0o700);
    vi.spyOn(fs, "chown").mockResolvedValue(undefined);

    const code = await runClaudeConfigNormalizerCli({
      argv: ["node", "claude-config-normalize.js", configDir],
      env,
    });

    expect(code).toBe(0);
    expect((await fs.stat(configDir)).mode & 0o7777).toBe(0o2770);
    expect((await fs.stat(path.join(configDir, "sessions"))).mode & 0o7777).toBe(0o2770);
  });
});
