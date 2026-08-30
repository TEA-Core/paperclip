import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so the managed-config test can force the runtime preparation
// step to throw an error that carries untrusted markers.
const { prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetUsesManagedHome: () => true,
    maybeRunSandboxInstallCommand: async () => null,
    prepareAdapterExecutionTargetRuntime,
  };
});

import {
  isAgentSideClaudeConfigPath,
  normalizeClaudeConfigDirTree,
  prepareClaudeConfigSeed,
  prepareSandboxClaudeProbeRuntime,
  seedAgentSideClaudeConfig,
} from "./claude-config.js";
import { runClaudeConfigNormalizerCli } from "./claude-config-normalize.js";

/**
 * Intercept the descriptor opens the walk performs so tests can fake ownership
 * (fstat override) or neutralize fchown on hosts without the `agents` group.
 */
function wrapOpenHandles(options: {
  fakeUidFor?: (openedPath: string) => number | undefined;
  chownNoop?: boolean;
}): void {
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (target, ...rest) => {
    const handle = await realOpen(target, ...rest);
    const fakeUid = options.fakeUidFor?.(String(target));
    return new Proxy(handle, {
      get(obj, prop) {
        if (fakeUid !== undefined && prop === "stat") {
          return async () => Object.assign(await obj.stat(), { uid: fakeUid });
        }
        if (options.chownNoop && prop === "chown") {
          return async () => undefined;
        }
        const value = Reflect.get(obj, prop);
        return typeof value === "function" ? value.bind(obj) : value;
      },
    });
  });
}

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

  it("normalizes nested dirs to 0o2770 and leaves files untouched", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-positive-"));
    cleanupDirs.push(home);
    const mid = path.join(home, "projects");
    const deep = path.join(mid, "work");
    await fs.mkdir(deep, { recursive: true });
    await fs.chmod(mid, 0o700);
    await fs.chmod(deep, 0o700);
    const file = path.join(deep, "state.json");
    await fs.writeFile(file, "{}");
    await fs.chmod(file, 0o640);

    const onLog = vi.fn(async () => {});
    await normalizeClaudeConfigDirTree(home, onLog);

    expect((await fs.stat(home)).mode & 0o7777).toBe(0o2770);
    expect((await fs.stat(mid)).mode & 0o7777).toBe(0o2770);
    expect((await fs.stat(deep)).mode & 0o7777).toBe(0o2770);
    expect((await fs.stat(file)).mode & 0o7777).toBe(0o640);
  });

  it("recurses through a dir owned by another uid without chmodding it and without logging", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-foreign-"));
    cleanupDirs.push(root);
    const foreignDir = path.join(root, "sessions");
    const innerDir = path.join(foreignDir, "inner");
    await fs.mkdir(innerDir, { recursive: true });
    await fs.chmod(foreignDir, 0o700);
    await fs.chmod(innerDir, 0o700);

    wrapOpenHandles({
      fakeUidFor: (opened) => (opened.endsWith(`${path.sep}sessions`) ? 999_999_999 : undefined),
      chownNoop: true,
    });

    const onLog = vi.fn(async () => {});
    await normalizeClaudeConfigDirTree(root, onLog);

    // The foreign-owned dir keeps its mode (the pass leaves it to the other uid)...
    expect(fsSync.statSync(foreignDir).mode & 0o7777).toBe(0o700);
    // ...but still recursed through it and fixed the owned child...
    expect(fsSync.statSync(innerDir).mode & 0o7777).toBe(0o2770);
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
    expect(fsSync.statSync(outside).mode & 0o7777).toBe(0o700);
    // The link itself was left untouched.
    expect(fsSync.lstatSync(path.join(home, "escape")).isSymbolicLink()).toBe(true);
  });

  it("refuses a root that is a symlink instead of normalizing its target", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-rootout-"));
    const rootParent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-root-"));
    cleanupDirs.push(outside, rootParent);
    await fs.chmod(outside, 0o700);
    const root = path.join(rootParent, "claude-config");
    await fs.symlink(outside, root);

    const onLog = vi.fn(async () => {});
    await normalizeClaudeConfigDirTree(root, onLog);

    // The target was never reached; the link was left alone.
    expect(fsSync.statSync(outside).mode & 0o7777).toBe(0o700);
    expect(fsSync.lstatSync(root).isSymbolicLink()).toBe(true);
  });

  it("never follows a child swapped for a symlink behind the parent's readdir", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-outside-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-race-"));
    cleanupDirs.push(outside, home);
    await fs.chmod(outside, 0o700);
    const swapped = path.join(home, "swapped");
    await fs.mkdir(swapped, { mode: 0o700 });

    // The attacker move, at the exact seam the old path-string walk exposed:
    // replace the child with a symlink to a target the walk's uid owns on the
    // walk's path-stat of the child. The fixed walk never stats children by
    // path, so this never fires.
    const realStat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
      if (String(target) === swapped) {
        await fs.rm(swapped, { recursive: true, force: true });
        await fs.symlink(outside, swapped);
      }
      return realStat(target, ...rest);
    });
    wrapOpenHandles({ chownNoop: true });

    const onLog = vi.fn(async () => {});
    await normalizeClaudeConfigDirTree(home, onLog);

    // The link target was never reached: still owner-only, never widened.
    expect(fsSync.statSync(outside).mode & 0o7777).toBe(0o700);
    // The home entry is still the real directory, normalized by the walk.
    expect(fsSync.lstatSync(swapped).isSymbolicLink()).toBe(false);
    expect(fsSync.statSync(swapped).mode & 0o7777).toBe(0o2770);
  });

  it("resolves silently for a vanished or non-directory root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-walk-gone-"));
    cleanupDirs.push(home);
    const file = path.join(home, "afile");
    await fs.writeFile(file, "x");
    const fileMode = (await fs.stat(file)).mode & 0o7777;

    const onLog = vi.fn(async () => {});
    await expect(normalizeClaudeConfigDirTree(path.join(home, "does-not-exist"), onLog)).resolves.toBe(
      undefined,
    );
    await expect(normalizeClaudeConfigDirTree(file, onLog)).resolves.toBeUndefined();
    expect(fsSync.statSync(file).mode & 0o7777).toBe(fileMode);
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
    wrapOpenHandles({ chownNoop: true });

    const code = await runClaudeConfigNormalizerCli({
      argv: ["node", "claude-config-normalize.js", configDir],
      env,
    });

    expect(code).toBe(0);
    expect((await fs.stat(configDir)).mode & 0o7777).toBe(0o2770);
    expect((await fs.stat(path.join(configDir, "sessions"))).mode & 0o7777).toBe(0o2770);
  });
});

describe("prepareSandboxClaudeProbeRuntime managed-config diagnostics", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a thrown config-materialization error out of every check and the log", async () => {
    // The runtime preparation throws an error that carries two untrusted values:
    // an opaque credential marker and a proxy marker. Neither may reach a check
    // or the server log. The log carries only the fixed context, the allowlisted
    // classification, and the safe error class name.
    const opaqueCredMarker = "OPAQUECREDMARKERconfig";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-mgmt-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    prepareAdapterExecutionTargetRuntime.mockRejectedValueOnce(
      new Error(`materialize failed with ${opaqueCredMarker} via ${proxyMarker}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-1",
      target: sandboxTarget,
      // The probe passes no CLAUDE_CONFIG_DIR, so the managed branch runs.
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env: {},
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });

    const failed = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failed).toBeTruthy();
    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });
});
