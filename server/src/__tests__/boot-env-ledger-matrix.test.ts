import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEnvOrigin, bootEnvReport, currentBootEnvPlan, operatorEnvValue, resetBootEnvForTests } from "@paperclipai/shared/boot-env";
import type { PaperclipConfig } from "@paperclipai/shared";
import type { Config } from "../config.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

// Representative keys per class (advisor section 3.2): source selection,
// database target, secret material, data location, code loading, plus one
// name no allowlist knows. Values are canaries only; none is a real secret.
function steeringEntries(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: "postgresql://steer.invalid/db",
    DATABASE_MIGRATION_URL: "postgresql://steer.invalid/migrations",
    PAPERCLIP_SECRETS_MASTER_KEY: "canary-master-key-value",
    PAPERCLIP_AGENT_JWT_SECRET: "canary-jwt-secret-value",
    BETTER_AUTH_SECRET: "canary-auth-secret-value",
    PAPERCLIP_HOME: path.join("CANARY-STEER-HOME"),
    PAPERCLIP_INSTANCE_ID: "steered-sibling",
    PAPERCLIP_WORKTREE_NAME: "steered-name",
    PAPERCLIP_WORKTREES_DIR: path.join("CANARY-STEER-WORKTREES"),
    PAPERCLIP_STORAGE_LOCAL_DIR: path.join("CANARY-STEER-STORAGE"),
    PAPERCLIP_DB_BACKUP_DIR: path.join("CANARY-STEER-BACKUPS"),
    PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join("CANARY-STEER-MASTER-KEY-FILE"),
    PAPERCLIP_SECRETS_PROVIDER: "canary-provider",
    DOTENV_KEY: "dotenv:v1:canary-key",
    NODE_OPTIONS: "--require=/nonexistent/canary-steer.cjs",
    PAPERCLIP_ZZ_UNLISTED: "canary-unlisted-value",
    ...overrides,
  };
}

function envFileContents(entries: Record<string, string>): string {
  return (
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

function buildLegacyConfig(
  sharedRoot: string,
  databaseMode: "embedded-postgres" | "postgres" = "embedded-postgres",
) {
  return {
    $meta: { version: 1, updatedAt: "2026-03-26T00:00:00.000Z", source: "configure" },
    database:
      databaseMode === "postgres"
        ? {
            mode: "postgres" as const,
            connectionString: "postgresql://legacy-config.invalid/paperclip",
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(sharedRoot, "data", "backups"),
            },
          }
        : {
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
    logging: { mode: "file" as const, logDir: path.join(sharedRoot, "logs") },
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
      publicBaseUrl: "http://127.0.0.1:3100",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as const,
      localDisk: { baseDir: path.join(sharedRoot, "data", "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted" as const,
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(sharedRoot, "secrets", "master.key") },
    },
  };
}

interface WorktreeFixture {
  root: string;
  repoRoot: string;
  worktreeName: string;
  worktreeRoot: string;
  stateDir: string;
  ownEnvPath: string;
  configPath: string;
  isolatedHome: string;
}

async function makeWorktreeFixture(options: {
  ownEnvContents?: string | null;
  ownEnvAsDirectory?: boolean;
  withConfig?: boolean;
  configContents?: string;
}): Promise<WorktreeFixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paperclip-ledger-matrix-"));
  const repoRoot = path.join(root, "repo");
  const worktreeName = "matrix-worktree";
  const worktreeRoot = path.join(repoRoot, worktreeName);
  const stateDir = path.join(worktreeRoot, ".paperclip");
  const isolatedHome = path.join(root, ".paperclip-worktrees");
  await fs.promises.mkdir(path.join(repoRoot, ".git"), { recursive: true });
  await fs.promises.mkdir(stateDir, { recursive: true });
  if (options.ownEnvAsDirectory) {
    await fs.promises.mkdir(path.join(stateDir, ".env"), { recursive: true });
  } else if (options.ownEnvContents !== null) {
    await fs.promises.writeFile(
      path.join(stateDir, ".env"),
      options.ownEnvContents ?? "PAPERCLIP_IN_WORKTREE=true\n",
      "utf8",
    );
  }
  if (options.withConfig !== false || options.configContents) {
    await fs.promises.writeFile(
      path.join(stateDir, "config.json"),
      options.configContents ??
        JSON.stringify(buildLegacyConfig(path.join(root, "shared-main")), null, 2) + "\n",
      "utf8",
    );
  }
  return {
    root,
    repoRoot,
    worktreeName,
    worktreeRoot,
    stateDir,
    ownEnvPath: path.join(stateDir, ".env"),
    configPath: path.join(stateDir, "config.json"),
    isolatedHome,
  };
}

beforeEach(() => {
  resetBootEnvForTests();
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("PAPERCLIP_") ||
      key.startsWith("DATABASE_") ||
      key === "BETTER_AUTH_SECRET" ||
      key === "DOTENV_KEY"
    ) {
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
    process.env[key] = value;
  }
  vi.restoreAllMocks();
});

interface BootedServer {
  warnings: string[];
  loadConfig: () => Config;
  readWorktreeBootIsolation: () => PaperclipConfig | null;
}

// Re-runs the server boot (config.ts module level) against the current
// fixture and cwd. A static import cannot work here: the module-level boot
// would run once, before any fixture exists; each scenario needs it fresh.
async function bootServerModules(): Promise<BootedServer> {
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  vi.resetModules();
  const worktree = await import("../worktree-config.js");
  const config = await import("../config.js");
  return {
    warnings,
    loadConfig: config.loadConfig,
    readWorktreeBootIsolation: worktree.readWorktreeBootIsolation,
  };
}

// Keys the repair legitimately derives (boot origin) are asserted not-steered
// instead of absent; everything a file planted must never have arrived.
const BOOT_DERIVED_KEYS: Record<string, true> = {
  PAPERCLIP_IN_WORKTREE: true,
  PAPERCLIP_HOME: true,
  PAPERCLIP_INSTANCE_ID: true,
  PAPERCLIP_CONFIG: true,
  PAPERCLIP_CONTEXT: true,
  PAPERCLIP_WORKTREE_NAME: true,
  PAPERCLIP_WORKTREES_DIR: true,
  PAPERCLIP_DB_BACKUP_ENABLED: true,
  PORT: true,
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: true,
};

function expectNotSuppliedBy(entries: Record<string, string>, allowedPresent: string[] = []) {
  const allowed = new Set(allowedPresent);
  for (const [key, planted] of Object.entries(entries)) {
    if (allowed.has(key)) {
      expect(process.env[key], `process.env.${key} must not be the planted value`).not.toBe(planted);
      continue;
    }
    if (BOOT_DERIVED_KEYS[key]) {
      expect(process.env[key], `process.env.${key} must not be the planted value`).not.toBe(planted);
      continue;
    }
    expect(process.env[key], `process.env.${key} must be absent`).toBeUndefined();
  }
}

function expectIsolatedIdentity(fixture: WorktreeFixture) {
  expect(process.env.PAPERCLIP_IN_WORKTREE).toBe("true");
  expect(process.env.PAPERCLIP_INSTANCE_ID).toBe(fixture.worktreeName);
  expect(process.env.PAPERCLIP_INSTANCE_ID).not.toBe("steered-sibling");
  expect(path.resolve(process.env.PAPERCLIP_HOME!)).toBe(path.resolve(fixture.isolatedHome));
  expect(process.env.PAPERCLIP_CONFIG).toBe(path.resolve(fixture.configPath));
}

function operatorWorktreeLayout(fixture: WorktreeFixture) {
  process.env.PAPERCLIP_WORKTREES_DIR = fixture.isolatedHome;
}

async function scanFilesFor(root: string, needle: string): Promise<string | null> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      let contents: string;
      try {
        contents = await fs.promises.readFile(entryPath, "utf8");
      } catch {
        continue;
      }
      if (needle.length > 0 && contents.includes(needle)) return entryPath;
    }
  }
  return null;
}

describe("boot env source x key matrix (SUP-24365)", () => {
  it("keeps clean own-file origins after repair and blocks protected names (X2/X3)", async () => {
    const fixture = await makeWorktreeFixture({
      ownEnvContents: envFileContents({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_AGENT_JWT_SECRET: "fixture-jwt",
        PAPERCLIP_SECRETS_MASTER_KEY: "fixture-master",
        PAPERCLIP_ZZ_UNLISTED: "fixture-protected",
        PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/nonexistent/fixture-master",
        PAPERCLIP_STORAGE_LOCAL_DIR: "/nonexistent/fixture-storage",
        ZZ_PLAIN: "fixture-plain",
      }),
    });
    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();
    for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_SECRETS_MASTER_KEY", "ZZ_PLAIN"]) {
      expect(bootEnvOrigin(key), key).toBe("own");
      expect(operatorEnvValue(key), key).toBeUndefined();
    }
    for (const key of ["PAPERCLIP_ZZ_UNLISTED", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_STORAGE_LOCAL_DIR"]) {
      expect(process.env[key] === undefined, key).toBe(true);
      expect(booted.warnings.some((line) => line.includes(key)), key).toBe(true);
    }
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("refuses main-home identity claims without rewriting the own file (X4)", async () => {
    const fixture = await makeWorktreeFixture({});
    process.env.HOME = path.join(fixture.root, "home");
    const contents = envFileContents({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_HOME: path.join(process.env.HOME, ".paperclip"),
      PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_WORKTREE_NAME: "default",
    });
    fs.writeFileSync(fixture.ownEnvPath, contents);
    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();
    expect(bootEnvReport().refusals.some((refusal) => refusal.kind === "identity")).toBe(true);
    expectIsolatedIdentity(fixture);
    expect(booted.loadConfig().embeddedPostgresDataDir).toBe(path.join(fixture.isolatedHome, "instances", fixture.worktreeName, "db"));
    expect(fs.readFileSync(fixture.ownEnvPath, "utf8")).toBe(contents);
  });

  it("never follows a clean own-file config redirect or rewrites its target (X5)", async () => {
    const fixture = await makeWorktreeFixture({});
    const sibling = path.join(fixture.repoRoot, "sibling", ".paperclip");
    fs.mkdirSync(sibling, { recursive: true });
    const siblingConfig = JSON.stringify(buildLegacyConfig(path.join(fixture.root, "sibling-data")));
    const siblingEnv = "PAPERCLIP_IN_WORKTREE=true\n";
    fs.writeFileSync(path.join(sibling, "config.json"), siblingConfig);
    fs.writeFileSync(path.join(sibling, ".env"), siblingEnv);
    fs.writeFileSync(fixture.ownEnvPath, `PAPERCLIP_IN_WORKTREE=true\nPAPERCLIP_CONFIG=${path.join(sibling, "config.json")}\n`);
    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    await bootServerModules();
    expect(currentBootEnvPlan()?.configPath).toBe(fixture.configPath);
    expect(fs.readFileSync(path.join(sibling, "config.json"), "utf8")).toBe(siblingConfig);
    expect(fs.readFileSync(path.join(sibling, ".env"), "utf8")).toBe(siblingEnv);
  });

  it("keeps exported worktree evidence when the own file declines and persists nothing (X8)", async () => {
    const contents = "ZZ_PLAIN=declined\n";
    const fixture = await makeWorktreeFixture({ ownEnvContents: contents });
    const originalConfig = fs.readFileSync(fixture.configPath, "utf8");
    fs.writeFileSync(path.join(fixture.worktreeRoot, ".env"), envFileContents(steeringEntries()));
    operatorWorktreeLayout(fixture);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();
    expect(currentBootEnvPlan()?.mode).toBe("worktree");
    expect(bootEnvReport().refusals.some((refusal) => refusal.kind === "undeclared")).toBe(true);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
    expectIsolatedIdentity(fixture);
    expect(fs.readFileSync(fixture.ownEnvPath, "utf8")).toBe(contents);
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(originalConfig);
    expect(fs.existsSync(fixture.isolatedHome)).toBe(false);
  });

  it("skips worktree cwd env even with an explicit instance config (X10)", async () => {
    const fixture = await makeWorktreeFixture({});
    const instance = path.join(fixture.root, "main");
    fs.mkdirSync(instance);
    fs.writeFileSync(path.join(instance, "config.json"), JSON.stringify(buildLegacyConfig(instance)));
    fs.writeFileSync(path.join(fixture.worktreeRoot, ".env"), envFileContents(steeringEntries()));
    process.env.PAPERCLIP_CONFIG = path.join(instance, "config.json");
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();
    expect(currentBootEnvPlan()?.mode).toBe("instance");
    expect(currentBootEnvPlan()?.sources.map((source) => source.kind)).toEqual(["own"]);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
    expect(booted.warnings.some((line) => line.includes(path.join(fixture.worktreeRoot, ".env")))).toBe(true);
  });

  it("does not read an ancestor config above the checkout in instance mode (X14)", async () => {
    const fixture = await makeWorktreeFixture({});
    const checkout = path.join(fixture.root, "nested");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, ".paperclip"));
    fs.writeFileSync(path.join(fixture.root, ".paperclip", "config.json"), "{}");
    fs.writeFileSync(path.join(fixture.root, ".paperclip", ".env"), "DATABASE_URL=postgresql://ancestor.invalid/db\n");
    process.env.HOME = path.join(fixture.root, "home");
    process.chdir(checkout);
    const booted = await bootServerModules();
    expect(currentBootEnvPlan()?.configPath).toBe(path.join(process.env.HOME, ".paperclip", "instances", "default", "config.json"));
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("never uses the signing secret from content-refused bytes (X18)", async () => {
    const fixture = await makeWorktreeFixture({
      ownEnvContents: 'PAPERCLIP_IN_WORKTREE=true\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=fixture-refused-secret\nBROKEN="unterminated\n',
    });
    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    await bootServerModules();
    const secret = process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET ?? "";
    expect(/^[0-9a-f]{64}$/.test(secret)).toBe(true);
    expect(await scanFilesFor(fixture.root, secret)).toBeNull();
  });

  it("worktree with a clean own file: own secrets load, cwd steering and file database URLs do not", async () => {
    const cwdSteering = steeringEntries();
    const fixture = await makeWorktreeFixture({
      ownEnvContents: envFileContents({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_AGENT_JWT_SECRET: "own-file-jwt",
        PAPERCLIP_SECRETS_MASTER_KEY: "own-file-master-key",
        PAPERCLIP_ZZ_UNLISTED: "own-file-unlisted",
        DATABASE_URL: "postgresql://own-file.invalid/db",
        DATABASE_MIGRATION_URL: "postgresql://own-file.invalid/migrations",
      }),
    });
    await fs.promises.writeFile(
      path.join(fixture.worktreeRoot, ".env"),
      envFileContents(cwdSteering),
      "utf8",
    );

    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();

    // The cwd file is never a source in worktree mode: its keys are absent,
    // and the keys the own file supplies keep the own file's value.
    expectNotSuppliedBy(cwdSteering, [
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY",
      "PAPERCLIP_ZZ_UNLISTED",
    ]);
    // Own-file values the worktree owns do load; database URLs never do.
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("own-file-jwt");
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).toBe("own-file-master-key");
    expect(process.env.PAPERCLIP_ZZ_UNLISTED).toBeUndefined();
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.DATABASE_MIGRATION_URL).toBeUndefined();
    expectIsolatedIdentity(fixture);
    const loaded = booted.loadConfig();
    expect(loaded.databaseUrl).toBeUndefined();
    expect(loaded.databaseMigrationUrl).toBeUndefined();
  });

  it("refused own file: every file-supplied key is restored and the boot isolates", async () => {
    const ownSteering = steeringEntries();
    const poisoned =
      [
        "PAPERCLIP_IN_WORKTREE=true",
        ...Object.entries(ownSteering).map(([key, value]) => `${key}=${value}`),
        'FOO="unterminated',
      ].join("\n") + "\n";
    const cwdSteering = steeringEntries({
      PAPERCLIP_ZZ_UNLISTED: "cwd-unlisted-after-refusal",
    });
    const fixture = await makeWorktreeFixture({ ownEnvContents: poisoned });
    await fs.promises.writeFile(
      path.join(fixture.worktreeRoot, ".env"),
      envFileContents(cwdSteering),
      "utf8",
    );

    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();

    expectNotSuppliedBy(ownSteering);
    expectNotSuppliedBy(cwdSteering);
    expectIsolatedIdentity(fixture);
    const loaded = booted.loadConfig();
    expect(loaded.databaseUrl).toBeUndefined();
    expect(loaded.secretsMasterKeyFilePath).not.toContain("CANARY-STEER");
    expect(loaded.secretsMasterKeyFilePath).toContain("matrix-worktree");
    expect(loaded.secretsMasterKeyFilePath).not.toContain("shared-main");
    expect(booted.warnings.some((line) => line.includes(fixture.ownEnvPath))).toBe(true);
  });

  it("own env path is a directory: refusal isolates and the signing secret is minted, never persisted", async () => {
    const fixture = await makeWorktreeFixture({ ownEnvAsDirectory: true, withConfig: false });

    process.chdir(fixture.worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = fixture.isolatedHome;
    const booted = await bootServerModules();

    const secret = process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET ?? "";
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // The minted value exists in no file under the fixture.
    const found = await scanFilesFor(fixture.root, secret);
    expect(found, `minted secret must not appear in any file, found in ${found}`).toBeNull();
    expectIsolatedIdentity(fixture);
    expect(booted.warnings.some((line) => line.includes(fixture.ownEnvPath))).toBe(true);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("own env file is unreadable (mode 000): same refusal, mint, and isolation", async () => {
    if (process.getuid?.() === 0) return; // mode 000 stays readable for root
    const fixture = await makeWorktreeFixture({ withConfig: false });
    await fs.promises.chmod(fixture.ownEnvPath, 0o000);
    try {
      process.chdir(fixture.worktreeRoot);
      process.env.PAPERCLIP_IN_WORKTREE = "true";
      process.env.PAPERCLIP_WORKTREES_DIR = fixture.isolatedHome;
      const booted = await bootServerModules();

      const secret = process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET ?? "";
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      const found = await scanFilesFor(fixture.root, secret);
      expect(found).toBeNull();
      expectIsolatedIdentity(fixture);
      expect(booted.loadConfig().databaseUrl).toBeUndefined();
    } finally {
      await fs.promises.chmod(fixture.ownEnvPath, 0o600).catch(() => undefined);
    }
  });

  it("ancestor .paperclip/.env is never a source for a worktree boot", async () => {
    const ancestorSteering = steeringEntries();
    const fixture = await makeWorktreeFixture({
      ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\nPAPERCLIP_AGENT_JWT_SECRET=own-jwt\n",
    });
    const ancestorState = path.join(fixture.repoRoot, ".paperclip");
    await fs.promises.mkdir(ancestorState, { recursive: true });
    await fs.promises.writeFile(
      path.join(ancestorState, ".env"),
      envFileContents(ancestorSteering),
      "utf8",
    );
    await fs.promises.writeFile(path.join(ancestorState, "config.json"), "{}\n", "utf8");

    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();

    expectNotSuppliedBy(ancestorSteering, ["PAPERCLIP_AGENT_JWT_SECRET"]);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("own-jwt");
    expectIsolatedIdentity(fixture);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("HOME default instance .env is never a source for a worktree boot", async () => {
    const homeSteering = steeringEntries();
    const fixture = await makeWorktreeFixture({
      ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\n",
    });
    const fixtureHome = path.join(fixture.root, "fixture-home");
    const defaultInstance = path.join(fixtureHome, ".paperclip", "instances", "default");
    await fs.promises.mkdir(defaultInstance, { recursive: true });
    await fs.promises.writeFile(
      path.join(defaultInstance, ".env"),
      envFileContents(homeSteering),
      "utf8",
    );
    await fs.promises.writeFile(path.join(defaultInstance, "config.json"), "{}\n", "utf8");

    const originalHome = process.env.HOME;
    process.env.HOME = fixtureHome;
    try {
      operatorWorktreeLayout(fixture);
      process.chdir(fixture.worktreeRoot);
      const booted = await bootServerModules();

      expectNotSuppliedBy(homeSteering);
      expectIsolatedIdentity(fixture);
      expect(booted.loadConfig().databaseUrl).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("PAPERCLIP_CONFIG set by a cwd file never redirects the worktree boot", async () => {
    const staging = await makeWorktreeFixture({ ownEnvContents: null, withConfig: false });
    const redirectState = path.join(staging.root, "redirect", ".paperclip");
    const fixture = await makeWorktreeFixture({
      ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\n",
    });
    await fs.promises.mkdir(redirectState, { recursive: true });
    const redirectEnv = steeringEntries({
      PAPERCLIP_CONFIG: path.join(redirectState, "config.json"),
    });
    await fs.promises.writeFile(path.join(redirectState, "config.json"), "{}\n", "utf8");
    await fs.promises.writeFile(
      path.join(redirectState, ".env"),
      envFileContents(redirectEnv),
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(fixture.worktreeRoot, ".env"),
      envFileContents({ PAPERCLIP_CONFIG: path.join(redirectState, "config.json") }),
      "utf8",
    );

    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();

    expectNotSuppliedBy(redirectEnv);
    expect(process.env.PAPERCLIP_CONFIG).toBe(path.resolve(fixture.configPath));
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe(fixture.worktreeName);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("a file-supplied DOTENV_KEY never opens a cwd vault (S3a)", async () => {
    const fixture = await makeWorktreeFixture({
      ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\nPAPERCLIP_AGENT_JWT_SECRET=own-jwt\nDOTENV_KEY=dotenv:v1:canary-from-own-file\n",
    });
    await fs.promises.writeFile(
      path.join(fixture.worktreeRoot, ".env.vault"),
      "DOTENV_VAULT_CWD_PROBE=canary-cwd-vault-value\n",
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(fixture.worktreeRoot, ".env"),
      "PAPERCLIP_CONFIG=/nonexistent/cwd-steer\n",
      "utf8",
    );

    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();

    expect(process.env.DOTENV_KEY).toBeUndefined();
    expect(process.env.DOTENV_VAULT_CWD_PROBE).toBeUndefined();
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("own-jwt");
    expectIsolatedIdentity(fixture);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("an operator DOTENV_KEY with a vault beside the own file opens nothing", async () => {
    const fixture = await makeWorktreeFixture({
      ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\nPAPERCLIP_AGENT_JWT_SECRET=own-jwt\n",
    });
    await fs.promises.writeFile(
      path.join(fixture.stateDir, ".env.vault"),
      "DOTENV_VAULT_PROBE=canary-vault-value\n",
      "utf8",
    );

    process.env.DOTENV_KEY = "dotenv:v1:canary-from-shell";
    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const booted = await bootServerModules();

    expect(process.env.DOTENV_VAULT_PROBE).toBeUndefined();
    expect(process.env.DOTENV_KEY).toBe("dotenv:v1:canary-from-shell");
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("own-jwt");
    expectIsolatedIdentity(fixture);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("instance mode keeps today's behaviour: own and cwd files both load", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paperclip-ledger-instance-"));
    const instanceState = path.join(root, "instance", ".paperclip");
    await fs.promises.mkdir(path.join(root, "instance", ".git"), { recursive: true });
    await fs.promises.mkdir(instanceState, { recursive: true });
    await fs.promises.writeFile(
      path.join(instanceState, ".env"),
      "DATABASE_URL=postgresql://instance-file.invalid/db\nPAPERCLIP_AGENT_JWT_SECRET=instance-jwt\n",
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(instanceState, "config.json"),
      JSON.stringify(buildLegacyConfig(path.join(root, "shared")), null, 2) + "\n",
      "utf8",
    );
    const workdir = path.join(root, "instance", "work");
    await fs.promises.mkdir(workdir, { recursive: true });
    await fs.promises.writeFile(path.join(workdir, ".env"), "PAPERCLIP_ZZ_CWD=cwd-value\n", "utf8");

    process.chdir(workdir);
    const booted = await bootServerModules();

    expect(process.env.DATABASE_URL).toBe("postgresql://instance-file.invalid/db");
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("instance-jwt");
    expect(process.env.PAPERCLIP_ZZ_CWD).toBe("cwd-value");
    expect(booted.loadConfig().databaseUrl).toBe("postgresql://instance-file.invalid/db");
  });

  it("invalid on-disk config.json with a clean own file refuses the boot (R8i)", async () => {
    const fixture = await makeWorktreeFixture({
      ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\n",
      configContents: "{ this is not json",
    });

    process.chdir(fixture.worktreeRoot);
    await expect(bootServerModules()).rejects.toThrow(/Refusing to boot on the on-disk config at/);
  });

  it("persist failure publishes in-memory isolation instead of throwing (R8h)", async () => {
    if (process.getuid?.() === 0) return; // mode 500 stays writable for root
    const scratch = await makeWorktreeFixture({
      ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\n",
    });
    const lockedHome = path.join(scratch.root, "locked-home");
    await fs.promises.mkdir(lockedHome, { recursive: true });
    await fs.promises.chmod(lockedHome, 0o500);
    const fixture: WorktreeFixture = { ...scratch, isolatedHome: lockedHome };

    try {
      process.chdir(fixture.worktreeRoot);
      process.env.PAPERCLIP_WORKTREES_DIR = lockedHome;
      const booted = await bootServerModules();

      expect(
        booted.warnings.some((line) => line.includes("Could not persist isolated worktree config")),
      ).toBe(true);
      const isolation = booted.readWorktreeBootIsolation();
      expect(isolation).not.toBeNull();
      const dataDir = path.resolve(booted.loadConfig().embeddedPostgresDataDir ?? "");
      expect(dataDir.startsWith(path.resolve(lockedHome))).toBe(true);
    } finally {
      await fs.promises.chmod(lockedHome, 0o700).catch(() => undefined);
    }
  });

  it("an isolated postgres config's connection string never becomes the databaseUrl (R8j2)", async () => {
    const fixture = await makeWorktreeFixture({ ownEnvContents: "PAPERCLIP_IN_WORKTREE=true\n" });
    await fs.promises.writeFile(
      fixture.configPath,
      JSON.stringify(
        buildLegacyConfig(path.join(fixture.root, "shared-main"), "postgres"),
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(fixture.worktreeRoot);
    delete process.env.DATABASE_URL;
    const booted = await bootServerModules();

    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
    expect(booted.readWorktreeBootIsolation()).not.toBeNull();

    // Second boot: the isolated config is on disk now, so this boot runs
    // with no in-memory isolation. The preserved legacy connection string
    // still must not become the databaseUrl.
    const rebooted = await bootServerModules();
    expect(rebooted.readWorktreeBootIsolation()).toBeNull();
    expect(rebooted.loadConfig().databaseUrl).toBeUndefined();
  });

  it("honours valid custom identity claims but refuses a sibling instance root (X6/X7)", async () => {
    const fixture = await makeWorktreeFixture({});
    process.env.HOME = path.join(fixture.root, "home");
    const customHome = path.join(fixture.root, "custom-worktrees");
    const claims = envFileContents({
      PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_HOME: customHome,
      PAPERCLIP_INSTANCE_ID: "custom-id", PAPERCLIP_WORKTREE_NAME: "Custom name",
    });
    fs.writeFileSync(fixture.ownEnvPath, claims);
    operatorWorktreeLayout(fixture);
    process.chdir(fixture.worktreeRoot);
    const first = await bootServerModules();
    expect(first.loadConfig().embeddedPostgresDataDir).toBe(path.join(customHome, "instances", "custom-id", "db"));
    expect(bootEnvReport().refusals).toEqual([]);

    const sibling = path.join(fixture.repoRoot, "sibling", ".paperclip");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "config.json"), JSON.stringify(buildLegacyConfig(path.join(customHome, "instances", "custom-id"))));
    fs.writeFileSync(fixture.ownEnvPath, claims);
    for (const key of Object.keys(process.env)) if (key.startsWith("PAPERCLIP_")) delete process.env[key];
    resetBootEnvForTests();
    operatorWorktreeLayout(fixture);
    const second = await bootServerModules();
    expect(bootEnvReport().refusals.some((refusal) => refusal.kind === "identity")).toBe(true);
    expect(second.loadConfig().embeddedPostgresDataDir).toBe(path.join(fixture.isolatedHome, "instances", fixture.worktreeName, "db"));
    expect(fs.readFileSync(fixture.ownEnvPath, "utf8")).toBe(claims);
  });

  it.each(["layout", "registry"])("retains %s worktree evidence after the declaration is removed (X9)", async (evidence) => {
    const fixture = await makeWorktreeFixture({});
    process.env.HOME = path.join(fixture.root, "home");
    let cwd = fixture.worktreeRoot;
    if (evidence === "layout") {
      cwd = path.join(fixture.root, "repo", ".paperclip", "worktrees", "isolated");
      fs.mkdirSync(path.dirname(cwd), { recursive: true });
      fs.renameSync(fixture.worktreeRoot, cwd);
    } else {
      fs.mkdirSync(fixture.isolatedHome, { recursive: true });
      fs.writeFileSync(path.join(fixture.isolatedHome, "worktree-port-reservations.json"), JSON.stringify({
        version: 1, configPaths: [fixture.configPath],
      }));
    }
    fs.mkdirSync(path.join(cwd, ".git"));
    const envPath = path.join(cwd, ".paperclip", ".env");
    fs.writeFileSync(envPath, "ZZ_PLAIN=declined\n");
    fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_URL=postgresql://fixture.invalid/db\n");
    operatorWorktreeLayout(fixture);
    process.chdir(cwd);
    const booted = await bootServerModules();
    expect(currentBootEnvPlan()?.mode).toBe("worktree");
    expect(currentBootEnvPlan()?.undeclared).toBe(true);
    expect(booted.loadConfig().databaseUrl).toBeUndefined();
    expect(fs.readFileSync(envPath, "utf8")).toBe("ZZ_PLAIN=declined\n");
  });
});
