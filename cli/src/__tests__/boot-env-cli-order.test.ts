import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBootEnvForTests } from "@paperclipai/shared/boot-env";
import { loadPaperclipEnvFile, readAgentJwtSecretFromEnv } from "../config/env.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

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

function makeWorktreeRefusedFixture(): { configPath: string; envPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-order-"));
  const stateDir = path.join(root, "wt", ".paperclip");
  fs.mkdirSync(stateDir, { recursive: true });
  const envPath = path.join(stateDir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "PAPERCLIP_IN_WORKTREE=true",
      "DATABASE_URL=postgresql://refused-file.invalid/db",
      "PAPERCLIP_SECRETS_MASTER_KEY=refused-file-master-key",
      "PAPERCLIP_AGENT_JWT_SECRET=refused-file-jwt",
      'FOO="unterminated',
      "",
    ].join("\n"),
    "utf8",
  );
  const configPath = path.join(stateDir, "config.json");
  fs.writeFileSync(configPath, "{}\n", "utf8");
  return { configPath, envPath };
}

describe("cli preload order (SUP-24365)", () => {
  it("a refused worktree env file keeps its secrets out of the process env at CLI preload time", () => {
    const { configPath } = makeWorktreeRefusedFixture();
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "operator-jwt";

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    loadPaperclipEnvFile(configPath);

    // The r9b door: the preload used to run before any capture, so the
    // refused file's values survived. The loader now refuses and restores.
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
    // The staged read returns the operator snapshot value, never the file's.
    expect(readAgentJwtSecretFromEnv(configPath)).toBe("operator-jwt");
  });

  it("a clean worktree env file still supplies its secret to CLI readers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-order-clean-"));
    const stateDir = path.join(root, "wt", ".paperclip");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, ".env"),
      "PAPERCLIP_IN_WORKTREE=true\nPAPERCLIP_AGENT_JWT_SECRET=clean-file-jwt\n",
      "utf8",
    );
    const configPath = path.join(stateDir, "config.json");
    fs.writeFileSync(configPath, "{}\n", "utf8");

    loadPaperclipEnvFile(configPath);

    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("clean-file-jwt");
    expect(readAgentJwtSecretFromEnv(configPath)).toBe("clean-file-jwt");
    // Worktree mode never lets a file pick the database.
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});
