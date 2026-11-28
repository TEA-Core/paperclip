import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureOperatorEnv, loadBootEnv, resetBootEnvForTests } from "@paperclipai/shared/boot-env";
import { printStartupBanner } from "../startup-banner.js";

const originalEnv = { ...process.env };
let root: string;
let envPath: string;

beforeEach(() => {
  resetBootEnvForTests();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_") || key.startsWith("DATABASE_")) delete process.env[key];
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-startup-banner-"));
  envPath = path.join(root, ".env");
  process.env.PAPERCLIP_CONFIG = path.join(root, "config.json");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  vi.restoreAllMocks();
  resetBootEnvForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function banner(): string {
  captureOperatorEnv();
  loadBootEnv({ cwd: root });
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  printStartupBanner({
    bind: "loopback",
    host: "127.0.0.1",
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: false,
    requestedPort: 3100,
    listenPort: 3100,
    uiMode: "none",
    db: { mode: "embedded-postgres", dataDir: path.join(root, "db"), port: 15432 },
    migrationSummary: "current",
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: path.join(root, "backups"),
  });
  return output.mock.calls.map((args) => args.join(" ")).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("startup banner env diagnostics", () => {
  it("distinguishes a refused own env file from a missing JWT secret", () => {
    fs.mkdirSync(envPath);
    const output = banner();
    expect(output).toMatch(/Agent JWT\s+env file refused:/);
    expect(output).toContain(envPath);
    expect(output).not.toContain("run `npx paperclipai onboard`");
  });

  it("keeps the onboarding instruction for an absent env file", () => {
    expect(banner()).toMatch(/Agent JWT\s+missing \(run `npx paperclipai onboard`\)/);
  });

  it("shows a refused env source even when an operator JWT is available", () => {
    fs.mkdirSync(envPath);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "operator-fixture-secret";
    const output = banner();
    expect(output).toMatch(/Agent JWT\s+set/);
    expect(output).toMatch(/Env files\s+refused:/);
    expect(output).toContain(`${envPath} (not-a-file)`);
    expect(output).not.toContain("operator-fixture-secret");
  });
});
