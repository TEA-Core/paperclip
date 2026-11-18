// The authoritative regression probe for the uid-scoped worktree state
// partition is scripts/probe-worktree-uid-partition.sh (SUP-14127, SUP-14126
// ruling item 4): it runs the resolution under two DISTINCT REAL uids and
// asserts a genuine EACCES on the other uid's 0o600 state plus own-scoped-dir
// resolution. A test that names a directory `uid-<n>` asserts a string
// convention, not a permission boundary — it must never substitute for that
// probe, and the probe's CI check is the gate for the SUP-14087/14118 cluster.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRuntimePortSelectionToConfig,
  maybePersistWorktreeRuntimePorts,
  maybeRepairLegacyWorktreeConfigAndEnvFiles,
} from "../worktree-config.js";
import { parse as parseEnvFile } from "dotenv";
import { updateEnvFileContents } from "@paperclipai/shared/env-file";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

// The ambient shell can carry real PAPERCLIP_* settings (agent shells export
// PAPERCLIP_CONFIG pointing at the live default instance). Repair helpers
// resolve paths from these, so a test that forgets to override one would
// otherwise rewrite the machine's real config/env files.
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete process.env[key];
    }
  }
  process.env.PAPERCLIP_INSTANCE_ID = "default";
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);

  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

function buildLegacyConfig(sharedRoot: string, publicBaseUrl = "http://127.0.0.1:3100") {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-03-26T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres" as const,
      embeddedPostgresDataDir: path.join(sharedRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(sharedRoot, "data", "backups"),
      },
    },
    logging: {
      mode: "file" as const,
      logDir: path.join(sharedRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted" as const,
      exposure: "private" as const,
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "explicit" as const,
      publicBaseUrl,
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as const,
      localDisk: {
        baseDir: path.join(sharedRoot, "data", "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted" as const,
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(sharedRoot, "secrets", "master.key"),
      },
    },
  };
}

function buildIsolatedConfig(instanceRoot: string, serverPort: number, databasePort: number) {
  const config = buildLegacyConfig(instanceRoot, `http://127.0.0.1:${serverPort}`);
  const instanceId = path.basename(instanceRoot);
  return {
    ...config,
    database: {
      ...config.database,
      embeddedPostgresPort: databasePort,
      backup: {
        ...config.database.backup,
        enabled: false,
      },
    },
    server: {
      ...config.server,
      port: serverPort,
    },
    secrets: {
      ...config.secrets,
      localEncrypted: {
        ...config.secrets.localEncrypted,
        keyFilePath: path.join("/etc/paperclip/worktrees", instanceId, "master.key"),
      },
    },
  };
}

describe("worktree config repair", () => {
  it("repairs legacy repo-local worktree config and env files into an isolated instance", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repair-"));
    const worktreeRoot = path.join(tempRoot, "PAP-884-ai-commits-component");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const sharedRoot = path.join(tempRoot, ".paperclip", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-884-ai-commits-component",
        "PAPERCLIP_AGENT_JWT_SECRET=shared-secret",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PORT;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: true,
    });

    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-884-ai-commits-component");

    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(instanceRoot, "db"));
    expect(repairedConfig.database.backup.enabled).toBe(false);
    expect(repairedConfig.database.backup.dir).toBe(path.join(instanceRoot, "data", "backups"));
    expect(repairedConfig.logging.logDir).toBe(path.join(instanceRoot, "logs"));
    expect(repairedConfig.storage.localDisk.baseDir).toBe(path.join(instanceRoot, "data", "storage"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(path.join("/etc/paperclip/worktrees", "pap-884-ai-commits-component", "master.key"));
    expect(repairedEnv).toContain(`PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).toContain('PAPERCLIP_INSTANCE_ID="pap-884-ai-commits-component"');
    expect(repairedEnv).toContain(`PAPERCLIP_CONFIG=${JSON.stringify(await fs.realpath(configPath))}`);
    expect(repairedEnv).toContain(`PAPERCLIP_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`);
    expect(repairedEnv).toContain('PAPERCLIP_DB_BACKUP_ENABLED="false"');
    expect(repairedEnv).toContain("PAPERCLIP_AGENT_JWT_SECRET=shared-secret");
    expect(repairedEnv).toContain("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=");
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
    expect(process.env.PORT).toBe("3101");
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("pap-884-ai-commits-component");
    expect(process.env.PAPERCLIP_DB_BACKUP_ENABLED).toBe("false");
    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toHaveLength(64);
  });

  it("disables backups in an otherwise isolated existing worktree config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-backup-migration-"));
    const worktreeRoot = path.join(tempRoot, "disable-worktree-backups");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "disable-worktree-backups");

    await fs.mkdir(paperclipDir, { recursive: true });
    const legacyIsolatedConfig = buildIsolatedConfig(instanceRoot, 3110, 54339);
    legacyIsolatedConfig.database.backup.enabled = true;
    await fs.writeFile(configPath, JSON.stringify(legacyIsolatedConfig, null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "# Keep this operator note during repair",
        `PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`,
        'PAPERCLIP_INSTANCE_ID="disable-worktree-backups"',
        `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
        'PAPERCLIP_DB_BACKUP_ENABLED="true" # managed worktree policy',
        'PAPERCLIP_IN_WORKTREE="true"',
        'PAPERCLIP_WORKTREE_NAME="disable-worktree-backups"',
        "# Keep this trailing note too",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.PAPERCLIP_INSTANCE_ID = "disable-worktree-backups";
    process.env.PAPERCLIP_CONFIG = configPath;
    process.env.PAPERCLIP_DB_BACKUP_ENABLED = "true";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "disable-worktree-backups";

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");

    expect(result).toEqual({ repairedConfig: true, repairedEnv: true });
    expect(repairedConfig.database.backup.enabled).toBe(false);
    expect(repairedEnv).toContain(
      'PAPERCLIP_DB_BACKUP_ENABLED="false" # managed worktree policy',
    );
    expect(repairedEnv).toContain("# Keep this operator note during repair");
    expect(repairedEnv).toContain("# Keep this trailing note too");
    expect(process.env.PAPERCLIP_DB_BACKUP_ENABLED).toBe("false");
  });

  it("preserves an externally supplied PORT while repairing worktree config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repair-external-port-"));
    const worktreeRoot = path.join(tempRoot, "PAP-10341-runtime-managed-port");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const sharedRoot = path.join(tempRoot, ".paperclip", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-10341-runtime-managed-port",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-10341-runtime-managed-port";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    process.env.PORT = "32987";
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3101);
    expect(process.env.PORT).toBe("32987");
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
  });

  it("never rewrites a main-instance env when ambient worktree flags leak into the process", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-leak-"));
    const homeDir = path.join(tempRoot, ".paperclip");
    const instanceRoot = path.join(homeDir, "instances", "default");
    const configPath = path.join(instanceRoot, "config.json");
    const envPath = path.join(instanceRoot, ".env");

    await fs.mkdir(instanceRoot, { recursive: true });
    const originalConfig = JSON.stringify(buildLegacyConfig(instanceRoot), null, 2) + "\n";
    await fs.writeFile(configPath, originalConfig, "utf8");
    const cleanEnv = [
      "# Paperclip environment variables",
      "# Generated by `paperclip onboard`",
      `PAPERCLIP_HOME=${JSON.stringify(homeDir)}`,
      'PAPERCLIP_INSTANCE_ID="default"',
      `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
      "",
    ].join("\n");
    await fs.writeFile(envPath, cleanEnv, "utf8");

    process.chdir(tempRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({ repairedConfig: false, repairedEnv: false });
    expect(await fs.readFile(envPath, "utf8")).toBe(cleanEnv);
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    expect(process.env.PAPERCLIP_HOME).toBe(homeDir);
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("default");
  });

  it("does not persist runtime ports into a main-instance config when ambient worktree flags leak in", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-leak-ports-"));
    const homeDir = path.join(tempRoot, ".paperclip");
    const instanceRoot = path.join(homeDir, "instances", "default");
    const configPath = path.join(instanceRoot, "config.json");

    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(instanceRoot), null, 2) + "\n", "utf8");

    process.chdir(tempRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;

    maybePersistWorktreeRuntimePorts({ serverPort: 3999, databasePort: 54399 });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(writtenConfig.server.port).toBe(3100);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54329);
  });

  it("does not adopt a .paperclip config whose own env does not declare a worktree", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-unattested-"));
    const repoRoot = path.join(tempRoot, "repo");
    const paperclipDir = path.join(repoRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");

    await fs.mkdir(paperclipDir, { recursive: true });
    const originalConfig =
      JSON.stringify(buildLegacyConfig(path.join(tempRoot, "shared")), null, 2) + "\n";
    await fs.writeFile(configPath, originalConfig, "utf8");
    const nonWorktreeEnv = [
      "# Paperclip environment variables",
      `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
      "",
    ].join("\n");
    await fs.writeFile(envPath, nonWorktreeEnv, "utf8");

    process.chdir(repoRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, ".paperclip-worktrees");
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({ repairedConfig: false, repairedEnv: false });
    expect(await fs.readFile(envPath, "utf8")).toBe(nonWorktreeEnv);
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
  });

  it("repairs a uid-scoped cross-uid worktree config layout in place without touching the canonical dir", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-scoped-uid-"));
    const worktreeRoot = path.join(tempRoot, "SUP-14087-cross-uid-worktree");
    const scopedDir = path.join(worktreeRoot, ".paperclip", "uid-1001");
    const configPath = path.join(scopedDir, "config.json");
    const envPath = path.join(scopedDir, ".env");
    const sharedRoot = path.join(tempRoot, "instances", "default");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceId = "sup-14087-cross-uid-worktree-uid-1001";
    const instanceRoot = path.join(isolatedHome, "instances", instanceId);

    // Simulate the poisoned state: the canonical config/env belong to another
    // uid (here just present, never to be rewritten).
    const canonicalDir = path.join(worktreeRoot, ".paperclip");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "config.json"), JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    const canonicalConfigBefore = await fs.readFile(path.join(canonicalDir, "config.json"), "utf8");
    await fs.writeFile(path.join(canonicalDir, ".env"), "PAPERCLIP_IN_WORKTREE=true\n", "utf8");
    const canonicalEnvBefore = await fs.readFile(path.join(canonicalDir, ".env"), "utf8");

    await fs.mkdir(scopedDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        `PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`,
        `PAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}`,
        `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
        `PAPERCLIP_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`,
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=SUP-14087-cross-uid-worktree",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "SUP-14087-cross-uid-worktree";
    process.env.PAPERCLIP_CONFIG = configPath;
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PORT;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");

    expect(result).toEqual({ repairedConfig: true, repairedEnv: true });
    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(instanceRoot, "db"));
    expect(repairedConfig.database.backup.enabled).toBe(false);
    expect(repairedConfig.logging.logDir).toBe(path.join(instanceRoot, "logs"));
    expect(repairedConfig.storage.localDisk.baseDir).toBe(path.join(instanceRoot, "data", "storage"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(path.join("/etc/paperclip/worktrees", instanceId, "master.key"));
    expect(repairedEnv).toContain(`PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).toContain('PAPERCLIP_DB_BACKUP_ENABLED="false"');
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
    expect(process.env.PAPERCLIP_CONFIG).toBe(configPath);

    // The other uid's canonical files are untouched.
    expect(await fs.readFile(path.join(canonicalDir, "config.json"), "utf8")).toBe(canonicalConfigBefore);
    expect(await fs.readFile(path.join(canonicalDir, ".env"), "utf8")).toBe(canonicalEnvBefore);
    expect(fsSync.existsSync(path.join(isolatedHome, "worktree-port-reservations.json"))).toBe(true);
  });

  it("rejects a uid-named dir that is not under a .paperclip directory", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-scoped-uid-reject-"));
    const homeDir = path.join(tempRoot, "instances", "default");
    const configPath = path.join(homeDir, "uid-1001", "config.json");
    const envPath = path.join(path.dirname(configPath), ".env");

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const originalConfig = JSON.stringify(buildLegacyConfig(homeDir), null, 2) + "\n";
    await fs.writeFile(configPath, originalConfig, "utf8");
    await fs.writeFile(
      envPath,
      ["PAPERCLIP_IN_WORKTREE=true", "PAPERCLIP_CONFIG=uid-1001/config.json"].join("\n"),
      "utf8",
    );

    process.chdir(tempRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({ repairedConfig: false, repairedEnv: false });
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
  });

  it("avoids sibling worktree ports when repairing legacy configs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repair-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-880-thumbs-capture-for-evals-feature");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const sharedRoot = path.join(tempRoot, ".paperclip", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const siblingInstanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.mkdir(siblingInstanceRoot, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-880-thumbs-capture-for-evals-feature",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(siblingInstanceRoot, "config.json"),
      JSON.stringify(
        {
          ...buildLegacyConfig(siblingInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(siblingInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(siblingInstanceRoot, "data", "backups"),
            },
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-880-thumbs-capture-for-evals-feature";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("serializes and persists cross-repo worktree port reservations", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-port-registry-"));
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const firstWorktreeRoot = path.join(tempRoot, "repo-one", "PAP-14013-import-bulk-skills");
    const secondWorktreeRoot = path.join(tempRoot, "repo-two", "PAP-14069-port-conflicts");
    const firstConfigPath = path.join(firstWorktreeRoot, ".paperclip", "config.json");
    const secondConfigPath = path.join(secondWorktreeRoot, ".paperclip", "config.json");

    const writeWorktree = async (
      worktreeRoot: string,
      name: string,
      databaseMode: "embedded-postgres" | "postgres" = "embedded-postgres",
    ) => {
      const paperclipDir = path.join(worktreeRoot, ".paperclip");
      const instanceRoot = path.join(isolatedHome, "instances", name.toLowerCase());
      const config = buildIsolatedConfig(instanceRoot, 45439, 55439);
      await fs.mkdir(paperclipDir, { recursive: true });
      await fs.writeFile(
        path.join(paperclipDir, "config.json"),
        `${JSON.stringify({
          ...config,
          database: {
            ...config.database,
            mode: databaseMode,
            ...(databaseMode === "postgres"
              ? { connectionString: "postgres://paperclip:paperclip@127.0.0.1:55439/paperclip" }
              : {}),
          },
        }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(paperclipDir, ".env"),
        [
          "# Paperclip environment variables",
          "PAPERCLIP_IN_WORKTREE=true",
          `PAPERCLIP_WORKTREE_NAME=${name}`,
          `PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`,
          `PAPERCLIP_INSTANCE_ID=${name.toLowerCase()}`,
          `PAPERCLIP_CONFIG=${JSON.stringify(path.join(paperclipDir, "config.json"))}`,
          "",
        ].join("\n"),
        "utf8",
      );
    };

    const activateWorktree = (worktreeRoot: string, name: string) => {
      process.chdir(worktreeRoot);
      process.env.PAPERCLIP_IN_WORKTREE = "true";
      process.env.PAPERCLIP_WORKTREE_NAME = name;
      process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
      process.env.PAPERCLIP_HOME = isolatedHome;
      process.env.PAPERCLIP_INSTANCE_ID = name.toLowerCase();
      process.env.PAPERCLIP_CONFIG = path.join(worktreeRoot, ".paperclip", "config.json");
      delete process.env.PORT;
      delete process.env.DATABASE_URL;
    };

    await writeWorktree(firstWorktreeRoot, "PAP-14013-import-bulk-skills", "postgres");
    await writeWorktree(secondWorktreeRoot, "PAP-14069-port-conflicts");
    const staleLockPath = path.join(isolatedHome, ".worktree-port-reservations.lock");
    await fs.mkdir(staleLockPath, { recursive: true });
    const staleLockTime = new Date(Date.now() - 6_000);
    await fs.utimes(staleLockPath, staleLockTime, staleLockTime);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    activateWorktree(firstWorktreeRoot, "PAP-14013-import-bulk-skills");
    expect(maybeRepairLegacyWorktreeConfigAndEnvFiles().repairedConfig).toBe(false);
    await expect(fs.stat(staleLockPath)).rejects.toMatchObject({ code: "ENOENT" });

    activateWorktree(secondWorktreeRoot, "PAP-14069-port-conflicts");
    expect(maybeRepairLegacyWorktreeConfigAndEnvFiles().repairedConfig).toBe(true);

    const firstConfig = JSON.parse(await fs.readFile(firstConfigPath, "utf8"));
    const secondConfig = JSON.parse(await fs.readFile(secondConfigPath, "utf8"));
    const registry = JSON.parse(
      await fs.readFile(path.join(isolatedHome, "worktree-port-reservations.json"), "utf8"),
    );

    expect(firstConfig.server.port).toBe(45439);
    expect(firstConfig.database.embeddedPostgresPort).toBe(55439);
    expect(secondConfig.server.port).toBe(45440);
    expect(secondConfig.database.embeddedPostgresPort).toBe(55440);
    expect(secondConfig.auth.publicBaseUrl).toBe("http://127.0.0.1:45440/");
    expect(registry.configPaths).toEqual([firstConfigPath, secondConfigPath].sort());
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Worktree port conflict detected"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("server: 45439 -> 45440"));

    warning.mockClear();
    expect(maybeRepairLegacyWorktreeConfigAndEnvFiles().repairedConfig).toBe(false);
    const persistedConfig = JSON.parse(await fs.readFile(secondConfigPath, "utf8"));
    expect(persistedConfig.server.port).toBe(45440);
    expect(persistedConfig.database.embeddedPostgresPort).toBe(55440);
    expect(warning).not.toHaveBeenCalled();
  });

  it("ignores stale migrated env paths when the dev runner resolved the local config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-migrated-env-"));
    const worktreeRoot = path.join(tempRoot, "PAP-9940-what-can-we-learn");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const oldHome = "/old/home/.paperclip-worktrees";
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(oldHome), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_HOME=/old/home/.paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=pap-9940-what-can-we-learn",
        "PAPERCLIP_CONFIG=/old/home/paperclip/.paperclip/worktrees/PAP-9940-what-can-we-learn/.paperclip/config.json",
        "PAPERCLIP_CONTEXT=/old/home/.paperclip-worktrees/context.json",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-9940-what-can-we-learn",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_CONFIG = configPath;
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-9940-what-can-we-learn");

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: true,
    });
    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(instanceRoot, "db"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(path.join("/etc/paperclip/worktrees", "pap-9940-what-can-we-learn", "master.key"));
    expect(repairedEnv).toContain(`PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).toContain(`PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`);
    expect(repairedEnv).not.toContain("/old/home");
  });

  it("does not persist transient runtime home overrides over repo-local worktree env", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-runtime-override-"));
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const transientHome = path.join(tempRoot, "tests", "e2e", ".tmp", "multiuser-authenticated");
    const worktreeRoot = path.join(tempRoot, "PAP-989-multi-user-implementation-using-plan-from-pap-958");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const instanceId = "pap-989-multi-user-implementation-using-plan-from-pap-958";
    const stableInstanceRoot = path.join(isolatedHome, "instances", instanceId);

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(transientHome),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(transientHome, "instances", instanceId, "db"),
            embeddedPostgresPort: 54334,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(transientHome, "instances", instanceId, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(transientHome, "instances", instanceId, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3104,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(transientHome, "instances", instanceId, "data", "storage"),
            },
            s3: {
              bucket: "paperclip",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(transientHome, "instances", instanceId, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        `PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`,
        `PAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}`,
        `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
        `PAPERCLIP_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`,
        'PAPERCLIP_IN_WORKTREE="true"',
        'PAPERCLIP_WORKTREE_NAME="PAP-989-multi-user-implementation-using-plan-from-pap-958"',
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-989-multi-user-implementation-using-plan-from-pap-958";
    process.env.PAPERCLIP_HOME = transientHome;
    process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    process.env.PAPERCLIP_CONFIG = configPath;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: true,
    });
    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(stableInstanceRoot, "db"));
    expect(repairedConfig.database.backup.dir).toBe(path.join(stableInstanceRoot, "data", "backups"));
    expect(repairedConfig.logging.logDir).toBe(path.join(stableInstanceRoot, "logs"));
    expect(repairedConfig.storage.localDisk.baseDir).toBe(path.join(stableInstanceRoot, "data", "storage"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(
      path.join("/etc/paperclip/worktrees", instanceId, "master.key"),
    );
    expect(repairedEnv).toContain(`PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).toContain('PAPERCLIP_DB_BACKUP_ENABLED="false"');
    expect(repairedEnv).not.toContain(`PAPERCLIP_HOME=${JSON.stringify(transientHome)}`);
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
  });

  it("rebalances duplicate ports for already isolated worktree configs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-rebalance-"));
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const repoWorktreesRoot = path.join(tempRoot, "repo", ".paperclip", "worktrees");
    const siblingWorktreeRoot = path.join(repoWorktreesRoot, "PAP-878-create-a-mine-tab-in-inbox");
    const siblingInstanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");
    const currentWorktreeRoot = path.join(repoWorktreesRoot, "PAP-884-ai-commits-component");
    const paperclipDir = path.join(currentWorktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const currentInstanceRoot = path.join(isolatedHome, "instances", "pap-884-ai-commits-component");
    const siblingConfigPath = path.join(siblingWorktreeRoot, ".paperclip", "config.json");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.mkdir(path.dirname(siblingConfigPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(currentInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(currentInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(currentInstanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(currentInstanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(currentInstanceRoot, "data", "storage"),
            },
            s3: {
              bucket: "paperclip",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(currentInstanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-884-ai-commits-component",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      siblingConfigPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(siblingInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(siblingInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(siblingInstanceRoot, "data", "backups"),
            },
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(currentWorktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("persists runtime-selected worktree ports back into explicit-port auth URLs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-878-create-a-mine-tab-in-inbox");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(instanceRoot, "http://my-host.ts.net:3100"),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(instanceRoot, "db"),
            embeddedPostgresPort: 54331,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(instanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(instanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(instanceRoot, "data", "storage"),
            },
            s3: {
              bucket: "paperclip",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(instanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(paperclipDir, ".env"),
      ["# Paperclip environment variables", "PAPERCLIP_IN_WORKTREE=true", ""].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-878-create-a-mine-tab-in-inbox";
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.PAPERCLIP_INSTANCE_ID = "pap-878-create-a-mine-tab-in-inbox";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;

    maybePersistWorktreeRuntimePorts({
      serverPort: 3103,
      databasePort: 54335,
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(writtenConfig.server.port).toBe(3103);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54335);
    expect(writtenConfig.auth.publicBaseUrl).toBe("http://my-host.ts.net:3103/");
  });

  it("does not rewrite no-port public auth URLs when persisting runtime-selected ports", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-public-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-125-public-base-url");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-125-public-base-url");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(instanceRoot, "https://paperclip.example"),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(instanceRoot, "db"),
            embeddedPostgresPort: 54331,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(instanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(instanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(instanceRoot, "data", "storage"),
            },
            s3: {
              bucket: "paperclip",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(instanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(paperclipDir, ".env"),
      ["# Paperclip environment variables", "PAPERCLIP_IN_WORKTREE=true", ""].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-125-public-base-url";
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.PAPERCLIP_INSTANCE_ID = "pap-125-public-base-url";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;

    maybePersistWorktreeRuntimePorts({
      serverPort: 3103,
      databasePort: 54335,
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(writtenConfig.server.port).toBe(3103);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54335);
    expect(writtenConfig.auth.publicBaseUrl).toBe("https://paperclip.example");
  });

  it("preserves top-level and nested config extensions while persisting runtime ports", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-config-extensions-"));
    const worktreeRoot = path.join(tempRoot, "config-extensions");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "config-extensions");
    const base = buildIsolatedConfig(instanceRoot, 3101, 54331);
    const config = {
      ...base,
      topLevelExtension: { enabled: true },
      database: {
        ...base.database,
        backup: {
          ...base.database.backup,
          backupExtension: "keep",
        },
      },
      server: {
        ...base.server,
        serverExtension: "keep",
      },
      storage: {
        ...base.storage,
        localDisk: {
          ...base.storage.localDisk,
          driverExtension: "keep",
        },
      },
    };

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await fs.writeFile(
      path.join(paperclipDir, ".env"),
      ["# Paperclip environment variables", "PAPERCLIP_IN_WORKTREE=true", ""].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "config-extensions";
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.PAPERCLIP_INSTANCE_ID = "config-extensions";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;

    const open = vi.spyOn(fsSync, "openSync");
    const sync = vi.spyOn(fsSync, "fsyncSync");
    maybePersistWorktreeRuntimePorts({ serverPort: 3103, databasePort: 54335 });

    expect(open).toHaveBeenCalledWith(paperclipDir, "r");
    expect(sync).toHaveBeenCalled();

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(writtenConfig).toMatchObject({
      topLevelExtension: { enabled: true },
      database: {
        embeddedPostgresPort: 54335,
        backup: { backupExtension: "keep" },
      },
      server: {
        port: 3103,
        serverExtension: "keep",
      },
      storage: {
        localDisk: { driverExtension: "keep" },
      },
    });

    const stableTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(configPath, stableTime, stableTime);
    maybePersistWorktreeRuntimePorts({ serverPort: 3103, databasePort: 54335 });
    expect((await fs.stat(configPath)).mtimeMs).toBe(stableTime.getTime());
  });

  it("can update the in-memory config when auth URL already includes a port", () => {
    const { config, changed } = applyRuntimePortSelectionToConfig(
      buildLegacyConfig("/tmp/shared", "http://my-host.ts.net:3100"),
      {
        serverPort: 3104,
        databasePort: 54340,
        allowServerPortWrite: false,
        allowDatabasePortWrite: true,
      },
    );

    expect(changed).toBe(true);
    expect(config.server.port).toBe(3100);
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.auth.publicBaseUrl).toBe("http://my-host.ts.net:3104/");
  });

  it("does not rewrite the in-memory config when auth URL has no explicit port", () => {
    const { config, changed } = applyRuntimePortSelectionToConfig(
      buildLegacyConfig("/tmp/shared", "https://paperclip.example"),
      {
        serverPort: 3104,
        databasePort: 54340,
        allowServerPortWrite: false,
        allowDatabasePortWrite: true,
      },
    );

    expect(changed).toBe(true);
    expect(config.server.port).toBe(3100);
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.auth.publicBaseUrl).toBe("https://paperclip.example");
  });

  it("repaired secrets key file path passes key path isolation via healthCheck", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-key-isolation-"));
    const worktreeRoot = path.join(tempRoot, "PAP-13011-key-isolation");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const sharedRoot = path.join(tempRoot, ".paperclip", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceId = "pap-13011-key-isolation";
    const instanceRoot = path.join(isolatedHome, "instances", instanceId);

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-13011-key-isolation",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-13011-key-isolation";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PORT;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    expect(result.repairedConfig).toBe(true);

    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const expectedKeyPath = path.join("/etc/paperclip/worktrees", instanceId, "master.key");
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(expectedKeyPath);

    const previousMasterKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const previousAllowKeyGeneration = process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const preFixKeyPath = path.join(instanceRoot, "secrets", "master.key");

    try {
      process.env.PAPERCLIP_HOME = isolatedHome;

      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = preFixKeyPath;
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;

      const preFixNoEnvKey = await localEncryptedProvider.healthCheck();
      expect(preFixNoEnvKey.status).toBe("error");
      expect(preFixNoEnvKey.message).toMatch(/Security violation/);

      process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("base64");

      const preFixEnvKey = await localEncryptedProvider.healthCheck();
      expect(preFixEnvKey.status).toBe("error");
      expect(preFixEnvKey.message).toMatch(/Security violation/);

      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = expectedKeyPath;
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;

      const healthNoEnvKey = await localEncryptedProvider.healthCheck();
      expect(healthNoEnvKey.status).not.toBe("error");
      expect(healthNoEnvKey.message).not.toContain("Security violation");

      const validEnvKey = randomBytes(32).toString("base64");
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = validEnvKey;

      const healthEnvKey = await localEncryptedProvider.healthCheck();
      expect(healthEnvKey.status).toBe("ok");
      expect(healthEnvKey.details?.keySource).toBe("env");
    } finally {
      if (previousMasterKeyFile === undefined) {
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      } else {
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousMasterKeyFile;
      }
      if (previousMasterKey === undefined) {
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      } else {
        process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
      }
      if (previousAllowKeyGeneration === undefined) {
        delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
      } else {
        process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = previousAllowKeyGeneration;
      }
      if (previousPaperclipHome === undefined) {
        delete process.env.PAPERCLIP_HOME;
      } else {
        process.env.PAPERCLIP_HOME = previousPaperclipHome;
      }
    }
  });

  it("never persists an inherited tool-action signing secret into the worktree env (SUP-24365)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-inherited-tool-secret-"));
    const worktreeRoot = path.join(tempRoot, "SUP-24365-inherited-secret");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const inheritedCanary = "CANARY_PARENT_SHELL_TOOL_ACTION_SECRET";
    const worktreeCanary = "CANARY_WORKTREE_TOOL_ACTION_SECRET";

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(path.join(tempRoot, "shared")), null, 2) + "\n", "utf8");
    await fs.writeFile(envPath, "PAPERCLIP_IN_WORKTREE=true\n", "utf8");

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, ".paperclip-worktrees");
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = inheritedCanary;
    delete process.env.PORT;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    maybeRepairLegacyWorktreeConfigAndEnvFiles();

    // Absent from the worktree env: the inherited value is kept for this boot
    // but never written into the worktree's own env file.
    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(inheritedCanary);
    const repairedEnv = await fs.readFile(envPath, "utf8");
    expect(repairedEnv).not.toContain(inheritedCanary);
    expect(repairedEnv).not.toContain("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=");

    // Present in the worktree env: the worktree value wins over the inherited one.
    await fs.appendFile(envPath, `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=${worktreeCanary}\n`, "utf8");
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = inheritedCanary;

    maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(worktreeCanary);
    const rerepairedEnv = await fs.readFile(envPath, "utf8");
    expect(rerepairedEnv).not.toContain(inheritedCanary);
  });

  it.each([
    { name: "double-quoted with an inline comment", line: 'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="CANARY_DQ_SECRET" # rotated by hand', value: "CANARY_DQ_SECRET" },
    { name: "single-quoted with an inline comment", line: "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET='CANARY_SQ_SECRET' # rotated by hand", value: "CANARY_SQ_SECRET" },
    { name: "unquoted with an inline comment", line: "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=CANARY_UQ_SECRET # rotated by hand", value: "CANARY_UQ_SECRET" },
    { name: "export-prefixed and double-quoted", line: 'export PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="CANARY_EXPORT_SECRET"', value: "CANARY_EXPORT_SECRET" },
    { name: "quoted with # inside the value", line: 'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="CANARY#HASH#SECRET" # rotated by hand', value: "CANARY#HASH#SECRET" },
  ])("reads and keeps a worktree tool-action secret that is $name (SUP-24365)", async ({ line, value }) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-secret-roundtrip-"));
    const worktreeRoot = path.join(tempRoot, "SUP-24365-secret-roundtrip");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(path.join(tempRoot, "shared")), null, 2) + "\n", "utf8");
    await fs.writeFile(envPath, ["PAPERCLIP_IN_WORKTREE=true", line, ""].join("\n"), "utf8");

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, ".paperclip-worktrees");
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "CANARY_PARENT_SHELL_TOOL_ACTION_SECRET";
    delete process.env.PORT;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
    const repairedEnv = await fs.readFile(envPath, "utf8");
    // The repair leaves the secret line byte-identical, and a later boot reads
    // the same value back from disk.
    expect(repairedEnv.split("\n")).toContain(line);
    expect(repairedEnv).not.toContain("CANARY_PARENT_SHELL_TOOL_ACTION_SECRET");
    delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
    maybeRepairLegacyWorktreeConfigAndEnvFiles();
    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
    expect(await fs.readFile(envPath, "utf8")).toBe(repairedEnv);
  });

  it.each([
    {
      name: "double-quoted multiline with a DATABASE_URL continuation",
      secretLines: [
        'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="alpha',
        "DATABASE_URL=postgresql://attacker:secret@evil.invalid/db",
        'omega"',
      ],
      value: "alpha\nDATABASE_URL=postgresql://attacker:secret@evil.invalid/db\nomega",
      injectedKey: "DATABASE_URL",
    },
    {
      name: "single-quoted multiline with a PORT continuation",
      secretLines: [
        "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET='alpha",
        "PORT=12345",
        "omega'",
      ],
      value: "alpha\nPORT=12345\nomega",
      injectedKey: "PORT",
    },
  ])("does not split a $name worktree secret into a loadable key (SUP-24365)", async ({ secretLines, value, injectedKey }) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-secret-multiline-"));
    const worktreeRoot = path.join(tempRoot, "SUP-24365-secret-multiline");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(path.join(tempRoot, "shared")), null, 2) + "\n", "utf8");
    const originalSecretBlock = secretLines.join("\n");
    await fs.writeFile(envPath, ["PAPERCLIP_IN_WORKTREE=true", originalSecretBlock, ""].join("\n"), "utf8");

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, ".paperclip-worktrees");
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "CANARY_PARENT_SHELL_TOOL_ACTION_SECRET";
    delete process.env.PORT;
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
    const repairedEnv = await fs.readFile(envPath, "utf8");
    expect(repairedEnv).toContain(originalSecretBlock);
    expect(repairedEnv).not.toContain("CANARY_PARENT_SHELL_TOOL_ACTION_SECRET");
    const parsed = parseEnvFile(repairedEnv);
    expect(parsed.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
    expect(parsed[injectedKey]).toBeUndefined();

    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "CANARY_PARENT_SHELL_TOOL_ACTION_SECRET";
    maybeRepairLegacyWorktreeConfigAndEnvFiles();
    expect(await fs.readFile(envPath, "utf8")).toBe(repairedEnv);
    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
  });

  it.each([
    { name: "backspace escape", line: String.raw`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="CANARY\bescape"`, value: String.raw`CANARY\bescape` },
    { name: "tab escape", line: String.raw`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="CANARY\tescape"`, value: String.raw`CANARY\tescape` },
    { name: "quote escape", line: String.raw`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="CANARY\"escape"`, value: String.raw`CANARY\"escape` },
  ])("does not rotate a worktree tool-action secret with a $name on every repair (SUP-24365)", async ({ line, value }) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-secret-escapes-"));
    const worktreeRoot = path.join(tempRoot, "SUP-24365-secret-escapes");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(path.join(tempRoot, "shared")), null, 2) + "\n", "utf8");
    await fs.writeFile(envPath, ["PAPERCLIP_IN_WORKTREE=true", line, ""].join("\n"), "utf8");

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, ".paperclip-worktrees");
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "CANARY_PARENT_SHELL_TOOL_ACTION_SECRET";
    delete process.env.PORT;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
    const repairedEnv = await fs.readFile(envPath, "utf8");
    expect(repairedEnv.split("\n")).toContain(line);
    expect(parseEnvFile(repairedEnv).PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);

    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "CANARY_PARENT_SHELL_TOOL_ACTION_SECRET";
    maybeRepairLegacyWorktreeConfigAndEnvFiles();
    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
    expect(await fs.readFile(envPath, "utf8")).toBe(repairedEnv);

    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "CANARY_PARENT_SHELL_TOOL_ACTION_SECRET";
    maybeRepairLegacyWorktreeConfigAndEnvFiles();
    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(value);
    expect(await fs.readFile(envPath, "utf8")).toBe(repairedEnv);
  });

  it.each([
    "PAPERCLIP_HOME",
    "PAPERCLIP_INSTANCE_ID",
    "PAPERCLIP_CONFIG",
    "PAPERCLIP_CONTEXT",
    "PAPERCLIP_IN_WORKTREE",
    "PAPERCLIP_DB_BACKUP_ENABLED",
    "PAPERCLIP_WORKTREE_NAME",
  ])("does not split a quoted multiline %s into a loadable key during repair (SUP-24365)", async (managedKey) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-managed-multiline-"));
    const name = "SUP-24365-managed-multiline";
    const instanceId = "sup-24365-managed-multiline";
    const worktreeRoot = path.join(tempRoot, name);
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", instanceId);

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(buildIsolatedConfig(instanceRoot, 45439, 55439), null, 2) + "\n",
      "utf8",
    );
    const baseLines = [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`,
      `PAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}`,
      `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
      `PAPERCLIP_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`,
      'PAPERCLIP_DB_BACKUP_ENABLED="false"',
      `PAPERCLIP_WORKTREE_NAME=${JSON.stringify(name)}`,
    ];
    const hostileBlock = [
      `${managedKey}="alpha`,
      "DATABASE_URL=postgresql://attacker:secret@evil.invalid/db",
      'omega"',
    ].join("\n");
    const envLines = baseLines.filter((line) => !line.startsWith(`${managedKey}=`));
    envLines.push(hostileBlock, "");
    const originalEnv = envLines.join("\n");
    await fs.writeFile(envPath, originalEnv, "utf8");

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    process.env.PAPERCLIP_WORKTREE_NAME = name;
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONTEXT;

    let thrown: unknown = null;
    try {
      maybeRepairLegacyWorktreeConfigAndEnvFiles();
    } catch (error) {
      thrown = error;
    }

    // Refusal is acceptable: the env file must be left byte-identical and
    // the loader must gain no key. The gate-blocked marker key is the one
    // case that returns without throwing.
    if (managedKey !== "PAPERCLIP_IN_WORKTREE") {
      expect(thrown).toBeInstanceOf(Error);
    }
    expect(await fs.readFile(envPath, "utf8")).toBe(originalEnv);
    expect(parseEnvFile(originalEnv).DATABASE_URL).toBeUndefined();
  });

  it("loader gains no key from quoted multiline shapes after the writer runs (SUP-24365)", () => {
    const managed = {
      PAPERCLIP_HOME: "/managed/home",
      PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_WORKTREE_NAME: "wt",
    };
    const shapes = [
      'PAPERCLIP_HOME="alpha\nDATABASE_URL=postgresql://a/b\nomega"\n',
      "PAPERCLIP_HOME='alpha\nBETTER_AUTH_SECRET=x\nomega'\n",
      'PAPERCLIP_DB_BACKUP_ENABLED="alpha\r\nPAPERCLIP_SECRETS_MASTER_KEY=x\r\nomega"\r\n',
      'UNRELATED="alpha\nPAPERCLIP_HOME=/evil\nomega"\n',
      'PAPERCLIP_HOME="alpha\\"\nPAPERCLIP_AGENT_JWT_SECRET=x\nomega"\n',
      'PAPERCLIP_HOME="/old"\nPAPERCLIP_HOME="alpha\nDATABASE_URL=postgresql://a/b\nomega"\n',
      'PAPERCLIP_WORKTREE_NAME="alpha\nDATABASE_URL=postgresql://a/b',
    ];

    for (const shape of shapes) {
      const beforeKeys = new Set(Object.keys(parseEnvFile(shape)));
      let updated: string | null = null;
      try {
        updated = updateEnvFileContents(shape, managed, { valueEncoding: "json" });
      } catch {
        updated = null;
      }
      if (updated === null) continue;
      const after = parseEnvFile(updated);
      for (const key of Object.keys(after)) {
        if (beforeKeys.has(key)) continue;
        expect(Object.hasOwn(managed, key)).toBe(true);
      }
      for (const [key, value] of Object.entries(managed)) {
        if (after[key] !== undefined && !shape.includes(`${key}=${value}`)) {
          // A managed key that was present may only hold a managed value.
          if (beforeKeys.has(key)) expect([value, after[key]]).toContain(after[key]);
        }
      }
      expect(after.DATABASE_URL).toBeUndefined();
      expect(after.BETTER_AUTH_SECRET).toBeUndefined();
      expect(after.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
      expect(after.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
    }
  });

  it.each([
    { name: "dotted double-quoted", opener: 'FOO.BAR="alpha', closer: 'omega"', newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "dotted single-quoted", opener: "FOO.BAR='alpha", closer: "omega'", newline: "\n", attacker: "PAPERCLIP_SECRETS_MASTER_KEY=attacker-key" },
    { name: "dotted backtick", opener: "FOO.BAR=`alpha", closer: "omega`", newline: "\n", attacker: "BETTER_AUTH_SECRET=attacker-secret" },
    { name: "dashed double-quoted", opener: 'FOO-BAR="alpha', closer: 'omega"', newline: "\n", attacker: "PAPERCLIP_AGENT_JWT_SECRET=attacker-secret" },
    { name: "dashed backtick", opener: "FOO-BAR=`alpha", closer: "omega`", newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "digit-led double-quoted", opener: '9FOO="alpha', closer: 'omega"', newline: "\n", attacker: "PAPERCLIP_CONFIG=/attacker/config.json" },
    { name: "digit-led backtick", opener: "9FOO=`alpha", closer: "omega`", newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "colon double-quoted", opener: 'FOO: "alpha', closer: 'omega"', newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "colon single-quoted", opener: "FOO: 'alpha", closer: "omega'", newline: "\n", attacker: "BETTER_AUTH_SECRET=attacker-secret" },
    { name: "export dotted double-quoted", opener: 'export FOO.BAR="alpha', closer: 'omega"', newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "leading tab dotted", opener: '\tFOO.BAR="alpha', closer: 'omega"', newline: "\n", attacker: "PAPERCLIP_SECRETS_MASTER_KEY=attacker-key" },
    { name: "tab around equals dotted", opener: 'FOO.BAR\t=\t"alpha', closer: 'omega"', newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "leading spaces dotted", opener: '  FOO.BAR="alpha', closer: 'omega"', newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "CRLF dotted double-quoted", opener: 'FOO.BAR="alpha', closer: 'omega"', newline: "\r\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db" },
    { name: "bare CR dotted double-quoted", opener: 'FOO.BAR="alpha', closer: 'omega"', newline: "\r", attacker: "PAPERCLIP_AGENT_JWT_SECRET=attacker-secret" },
    { name: "BOM dotted double-quoted", opener: '\uFEFFFOO.BAR="alpha', closer: 'omega"', newline: "\n", attacker: "DATABASE_URL=postgresql://attacker.invalid/db", openerFirst: true },
  ])("refuses a worktree env whose $name opener hides a managed line (SUP-24365)", async ({ opener, closer, newline, attacker, openerFirst }) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-hidden-opener-"));
    const name = "SUP-24365-hidden-opener";
    const worktreeRoot = path.join(tempRoot, name);
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const envPath = path.join(paperclipDir, ".env");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");

    await fs.mkdir(paperclipDir, { recursive: true });
    const block = [opener, "PAPERCLIP_DB_BACKUP_ENABLED=true", attacker, closer];
    const lines = openerFirst
      ? [...block, "PAPERCLIP_IN_WORKTREE=true", ""]
      : ["PAPERCLIP_IN_WORKTREE=true", ...block, ""];
    const originalEnv = lines.join(newline);
    await fs.writeFile(envPath, originalEnv, "utf8");

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    process.env.PAPERCLIP_WORKTREE_NAME = name;
    process.env.PAPERCLIP_CONFIG = path.join(paperclipDir, "config.json");
    delete process.env.PORT;
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONTEXT;
    delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;

    expect(parseEnvFile(originalEnv).DATABASE_URL).toBeUndefined();
    let thrown: unknown = null;
    try {
      maybeRepairLegacyWorktreeConfigAndEnvFiles();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(await fs.readFile(envPath, "utf8")).toBe(originalEnv);
  });

  it("randomized differential: repair never gains a loader key (seed 24365, SUP-24365)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-differential-"));
    const name = "SUP-24365-differential";
    const worktreeRoot = path.join(tempRoot, name);
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const envPath = path.join(paperclipDir, ".env");
    const configPath = path.join(paperclipDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceId = "sup-24365-differential";

    await fs.mkdir(paperclipDir, { recursive: true });

    // Deterministic PRNG so the generated grammar is reproducible.
    let state = 24365;
    const rand = () => {
      state |= 0; state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

    const openers = [
      { open: (q: string) => `FOO.BAR=${q}alpha`, close: (q: string) => `omega${q}` },
      { open: (q: string) => `FOO-BAR=${q}alpha`, close: (q: string) => `omega${q}` },
      { open: (q: string) => `9FOO=${q}alpha`, close: (q: string) => `omega${q}` },
      { open: (q: string) => `FOO: ${q}alpha`, close: (q: string) => `omega${q}` },
      { open: (q: string) => `export FOO.BAR=${q}alpha`, close: (q: string) => `omega${q}` },
      { open: (q: string) => `\tFOO.BAR=${q}alpha`, close: (q: string) => `omega${q}` },
      { open: (q: string) => `UNRELATED=${q}alpha`, close: (q: string) => `omega${q}` },
      { open: (q: string) => `UNRELATED=${q}alpha`, close: (q: string) => `omega${q} # note` },
    ];
    const attackerKeys = [
      "DATABASE_URL=postgresql://attacker.invalid/db",
      "PAPERCLIP_SECRETS_MASTER_KEY=attacker-key",
      "BETTER_AUTH_SECRET=attacker-secret",
      "PAPERCLIP_AGENT_JWT_SECRET=attacker-secret",
    ];
    const deterministicManaged: Record<string, string> = {
      PAPERCLIP_HOME: isolatedHome,
      PAPERCLIP_INSTANCE_ID: instanceId,
      PAPERCLIP_CONFIG: configPath,
      PAPERCLIP_CONTEXT: path.join(isolatedHome, "context.json"),
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_WORKTREE_NAME: name,
    };

    for (let iteration = 0; iteration < 48; iteration += 1) {
      const quote = pick(['"', "'", "`"] as const);
      const opener = pick(openers);
      const newline = pick(["\n", "\r\n", "\r"] as const);
      const lines = [
        ...(rand() < 0.5 ? ["# generated operator comment", ""] : []),
        "PAPERCLIP_IN_WORKTREE=true",
        ...(rand() < 0.5 ? [`PLAIN_UNRELATED=${iteration}`] : []),
        opener.open(quote),
        pick(["PAPERCLIP_DB_BACKUP_ENABLED=true", "PAPERCLIP_HOME=/evil", "PLAIN_INNER=1"] as const),
        pick(attackerKeys),
        opener.close(quote),
        ...(rand() < 0.5 ? [`DUP=value-${iteration}`, `DUP=value-${iteration}`] : []),
        "",
      ];
      const originalEnv = lines.join(newline);
      await fs.writeFile(envPath, originalEnv, "utf8");

      process.chdir(worktreeRoot);
      process.env.PAPERCLIP_IN_WORKTREE = "true";
      process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
      process.env.PAPERCLIP_WORKTREE_NAME = name;
      process.env.PAPERCLIP_CONFIG = configPath;
      delete process.env.PORT;
      delete process.env.DATABASE_URL;
      delete process.env.PAPERCLIP_HOME;
      delete process.env.PAPERCLIP_INSTANCE_ID;
      delete process.env.PAPERCLIP_CONTEXT;
      delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;

      const before = parseEnvFile(originalEnv);
      let thrown: unknown = null;
      try {
        maybeRepairLegacyWorktreeConfigAndEnvFiles();
      } catch (error) {
        thrown = error;
      }
      const afterContents = await fs.readFile(envPath, "utf8");
      if (thrown) {
        expect(afterContents).toBe(originalEnv);
        continue;
      }
      const after = parseEnvFile(afterContents);
      for (const [key, value] of Object.entries(after)) {
        if (Object.hasOwn(deterministicManaged, key)) {
          expect(value).toBe(deterministicManaged[key]);
        } else if (key === "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET") {
          expect(value).toMatch(/^[0-9a-f]{64}$/);
        } else {
          expect(before[key]).toBe(value);
        }
      }
      expect(after.DATABASE_URL).toBeUndefined();
      expect(after.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
      expect(after.BETTER_AUTH_SECRET).toBeUndefined();
      expect(after.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
    }
  });

  it("reads quoted and commented worktree markers and identity the same way the server loads them (SUP-24365)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-quoted-identity-"));
    const worktreeRoot = path.join(tempRoot, "SUP-24365-quoted-identity");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(path.join(tempRoot, "shared")), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        'PAPERCLIP_IN_WORKTREE="true" # worktree marker',
        "export PAPERCLIP_INSTANCE_ID='sup-24365-quoted' # set by worktree init",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, ".paperclip-worktrees");
    delete process.env.PORT;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result.repairedConfig).toBe(true);
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("sup-24365-quoted");
  });
});
