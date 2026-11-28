import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("refused worktree cwd env", () => {
  it("does not let a worktree-root .env steer a refused boot (SUP-24365)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-cwd-env-"));
    const name = "physical-worktree";
    const worktreeRoot = path.join(tempRoot, name);
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const steeredHome = path.join(tempRoot, "steered-home");
    const fileDatabaseUrl = "postgresql://main.invalid/paperclip";
    const fileMasterKey = "canary-master-key-value";
    const fileJwt = "canary-jwt-secret-value";

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      path.join(paperclipDir, ".env"),
      [
        "PAPERCLIP_IN_WORKTREE=true",
        `PAPERCLIP_SECRETS_MASTER_KEY=${fileMasterKey}`,
        `PAPERCLIP_AGENT_JWT_SECRET=${fileJwt}`,
        'FOO.BAR="alpha',
        "DATABASE_URL=postgresql://attacker.invalid/db",
        'omega"',
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(worktreeRoot, ".env"),
      [
        "PAPERCLIP_WORKTREE_NAME=steered-sibling",
        `PAPERCLIP_WORKTREES_DIR=${steeredHome}`,
        `DATABASE_URL=${fileDatabaseUrl}`,
        `PAPERCLIP_SECRETS_MASTER_KEY_FILE=${path.join(tempRoot, "shared.key")}`,
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PAPERCLIP_") || key === "DATABASE_URL" || key === "BETTER_AUTH_SECRET") {
        delete process.env[key];
      }
    }
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_CONFIG = path.join(paperclipDir, "config.json");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // config.ts snapshots operator env, loads both env files, then repairs.
      // A static import would do that before this fixture exists.
      const { loadConfig } = await import("../config.js");
      const booted = loadConfig();
      expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("physical-worktree");
      expect(process.env.PAPERCLIP_INSTANCE_ID).not.toBe("steered-sibling");
      expect(process.env.PAPERCLIP_HOME).not.toBe(steeredHome);
      expect(process.env.DATABASE_URL).not.toBe(fileDatabaseUrl);
      expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).not.toBe(fileMasterKey);
      expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).not.toBe(fileJwt);
      expect(booted.databaseUrl).not.toBe(fileDatabaseUrl);
    } finally {
      warning.mockRestore();
    }
  });
});
