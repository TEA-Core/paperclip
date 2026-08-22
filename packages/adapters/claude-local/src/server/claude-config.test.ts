import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeConfigSeed, probeClaudeConfigCredentialHealth } from "./claude-config.js";

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

describe("probeClaudeConfigCredentialHealth", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-credential-health-"));
    cleanupDirs.push(dir);
    return dir;
  }

  async function writeCredentials(dir: string, fileName: string, oauth: Record<string, unknown>) {
    await fs.writeFile(path.join(dir, fileName), JSON.stringify({ claudeAiOauth: oauth }), "utf8");
  }

  const nowSec = Math.floor(Date.now() / 1000);

  it("returns ok when access and refresh tokens are in the future", async () => {
    const dir = await makeDir();
    await writeCredentials(dir, ".credentials.json", {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresAt: nowSec + 8 * 60 * 60,
      refreshTokenExpiresAt: nowSec + 30 * 24 * 60 * 60,
    });
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("ok");
    expect(health.accessExpiresAtMs).toBeGreaterThan(Date.now());
    expect(health.refreshExpiresAtMs).toBeGreaterThan(Date.now());
  });

  it("returns access_expired when the access token is past expiry", async () => {
    const dir = await makeDir();
    await writeCredentials(dir, ".credentials.json", {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresAt: nowSec - 60,
      refreshTokenExpiresAt: nowSec + 30 * 24 * 60 * 60,
    });
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("access_expired");
    expect(health.accessExpiresAtMs).toBeLessThan(Date.now());
    expect(health.refreshExpiresAtMs).toBeGreaterThan(Date.now());
  });

  it("returns refresh_expiring when the refresh window is within 24 hours", async () => {
    const dir = await makeDir();
    await writeCredentials(dir, ".credentials.json", {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresAt: nowSec + 8 * 60 * 60,
      refreshTokenExpiresAt: nowSec + 12 * 60 * 60,
    });
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("refresh_expiring");
  });

  it("returns refresh_expired when the refresh window is past", async () => {
    const dir = await makeDir();
    await writeCredentials(dir, ".credentials.json", {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresAt: nowSec - 60,
      refreshTokenExpiresAt: nowSec - 60,
    });
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("refresh_expired");
  });

  it("falls back to credentials.json when .credentials.json is absent", async () => {
    const dir = await makeDir();
    await writeCredentials(dir, "credentials.json", {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresAt: nowSec + 60 * 60,
      refreshTokenExpiresAt: nowSec + 7 * 24 * 60 * 60,
    });
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("ok");
  });

  it("returns missing for an empty config directory", async () => {
    const dir = await makeDir();
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("missing");
  });

  it("returns unparseable for invalid JSON", async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, ".credentials.json"), "not-json", "utf8");
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("unparseable");
  });

  it("returns no_oauth_token when the oauth section is absent", async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, ".credentials.json"), JSON.stringify({ other: true }), "utf8");
    const health = await probeClaudeConfigCredentialHealth(dir);
    expect(health.status).toBe("no_oauth_token");
  });
});
