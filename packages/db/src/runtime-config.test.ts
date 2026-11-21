import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBootEnvForTests } from "@paperclipai/shared/boot-env";
import { resolveDatabaseTarget } from "./runtime-config.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

beforeEach(() => {
  resetBootEnvForTests();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_") || key.startsWith("DATABASE_")) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function writeLegacyEmbeddedConfig(configPath: string, sharedRoot: string) {
  writeJson(configPath, {
    $meta: { version: 1, updatedAt: "2026-03-26T00:00:00.000Z", source: "configure" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(sharedRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(sharedRoot, "data", "backups"),
      },
    },
    logging: { mode: "file", logDir: path.join(sharedRoot, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "explicit",
      publicBaseUrl: "http://127.0.0.1:3100",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(sharedRoot, "data", "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(sharedRoot, "secrets", "master.key") },
    },
  });
}

function makeWorktreeFixture(envContents: string): { worktreeRoot: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-target-"));
  const worktreeRoot = path.join(root, "repo", "wt");
  const stateDir = path.join(worktreeRoot, ".paperclip");
  fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  writeText(path.join(stateDir, ".env"), envContents);
  const configPath = path.join(stateDir, "config.json");
  writeLegacyEmbeddedConfig(configPath, path.join(root, "shared-main"));
  return { worktreeRoot, configPath };
}

describe("resolveDatabaseTarget", () => {
  it("uses DATABASE_URL from process env first", () => {
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.example.com:5432/paperclip";

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://env-user:env-pass@db.example.com:5432/paperclip",
      source: "DATABASE_URL",
    });
  });

  it("uses DATABASE_URL from repo-local .paperclip/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      'DATABASE_URL="postgres://file-user:file-pass@db.example.com:6543/paperclip"\n',
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://file-user:file-pass@db.example.com:6543/paperclip",
      source: "paperclip-env",
    });
  });

  it("uses config postgres connection string when configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      source: "config.database.connectionString",
    });
  });

  it("falls back to embedded postgres settings from config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: "~/paperclip-test-db",
        embeddedPostgresPort: 55444,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "paperclip-test-db"),
      port: 55444,
      source: "embedded-postgres@55444",
    });
  });

  it("uses the instance root for a fresh default embedded postgres target", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.DATABASE_URL;

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.join(home, "instances", "default", "db"),
      port: 54329,
      source: "embedded-postgres@54329",
      configPath: path.join(home, "instances", "default", "config.json"),
      envPath: path.join(home, "instances", "default", ".env"),
    });
  });

  it("never picks a refused worktree env file's DATABASE_URL (SUP-24365)", () => {
    const { worktreeRoot, configPath } = makeWorktreeFixture(
      [
        "PAPERCLIP_IN_WORKTREE=true",
        "DATABASE_URL=postgresql://refused-file.invalid/db",
        'FOO="unterminated',
        "",
      ].join("\n"),
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_CONFIG = configPath;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const target = resolveDatabaseTarget();
    expect(target.mode).toBe("embedded-postgres");
    expect(target.source).toContain("embedded-postgres@");
  });

  it("still uses a clean worktree env file's DATABASE_URL (SUP-24365)", () => {
    const { worktreeRoot, configPath } = makeWorktreeFixture(
      ["PAPERCLIP_IN_WORKTREE=true", "DATABASE_URL=postgresql://clean-file.invalid/db", ""].join("\n"),
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_CONFIG = configPath;

    const target = resolveDatabaseTarget();
    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgresql://clean-file.invalid/db",
      source: "paperclip-env",
    });
  });
});
