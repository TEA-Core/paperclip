import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeRepairLegacyWorktreeConfigAndEnvFiles } from "../worktree-config.js";
import { captureOperatorEnv, resetBootEnvForTests } from "@paperclipai/shared/boot-env";

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("worktree with no config file", () => {
  it("isolates a worktree whose .paperclip directory has no config.json (SUP-24365)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-no-config-"));
    const name = "no-config-worktree";
    const worktreeRoot = path.join(tempRoot, name);
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(path.join(paperclipDir, ".env"), "PAPERCLIP_IN_WORKTREE=true\n", "utf8");

    process.chdir(worktreeRoot);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PAPERCLIP_")) delete process.env[key];
    }
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetBootEnvForTests();
    captureOperatorEnv();
    maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("no-config-worktree");
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
    expect(process.env.PAPERCLIP_CONFIG).toBe(path.join(paperclipDir, "config.json"));
    expect(process.env.PAPERCLIP_HOME).not.toContain(`${path.sep}.paperclip${path.sep}instances${path.sep}default`);
  });
});
