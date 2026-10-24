import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_DISK_MAX_USED_PERCENT_ENV as ENV,
  checkWorkspaceDiskHeadroom,
  diskUsedPercent,
  resolveWorkspaceDiskMaxUsedPercent,
} from "../services/workspace-disk-headroom.ts";
import { WORKSPACE_GIT_SCAN_ERROR_CODES, WorkspaceGitScanError } from "../services/workspace-git-operation-scheduler.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";

// SUP-20840 — provisioning refuses to create a new worktree once the data volume is
// at or above the configured used-percent limit (default 80).

const execFileAsync = promisify(execFile);

// A 1000-block volume that is `usedPercent`% used, with no reserved blocks.
const statAt = (usedPercent: number) => async () => ({ blocks: 1000, bfree: 1000 - usedPercent * 10, bavail: 1000 - usedPercent * 10 });

describe("resolveWorkspaceDiskMaxUsedPercent", () => {
  it("defaults to 80 and honours an explicit limit", () => {
    expect(resolveWorkspaceDiskMaxUsedPercent({})).toBe(80);
    expect(resolveWorkspaceDiskMaxUsedPercent({ [ENV]: "65" })).toBe(65);
  });

  it("is disabled only by 0; anything else unparseable falls back to the default", () => {
    expect(resolveWorkspaceDiskMaxUsedPercent({ [ENV]: "0" })).toBeNull();
    for (const typo of ["off", "false", "disabled", "eighty"]) {
      expect(resolveWorkspaceDiskMaxUsedPercent({ [ENV]: typo })).toBe(80);
    }
    expect(resolveWorkspaceDiskMaxUsedPercent({ [ENV]: "150" })).toBe(80);
  });
});

describe("diskUsedPercent", () => {
  it("matches df: reserved blocks count as used", () => {
    expect(diskUsedPercent({ blocks: 1000, bfree: 100, bavail: 50 })).toBeCloseTo((900 / 950) * 100);
    expect(diskUsedPercent({ blocks: 0, bfree: 0, bavail: 0 })).toBe(0);
  });
});

describe("checkWorkspaceDiskHeadroom", () => {
  it("allows provisioning below the limit", async () => {
    expect(await checkWorkspaceDiskHeadroom({ path: "/x", env: {}, statfs: statAt(79) })).toBeNull();
  });

  it("refuses at the limit and above, with a message that names the env var", async () => {
    for (const used of [80, 100]) {
      const refusal = await checkWorkspaceDiskHeadroom({ path: "/x", env: {}, statfs: statAt(used) });
      expect(refusal?.message).toContain(`${used.toFixed(1)}% used`);
      expect(refusal?.message).toContain(ENV);
      expect(refusal?.details).toMatchObject({ maxUsedPercent: 80, usedPercent: used });
    }
  });

  it("uses the configured limit and can be disabled", async () => {
    expect(await checkWorkspaceDiskHeadroom({ path: "/x", env: { [ENV]: "95" }, statfs: statAt(90) })).toBeNull();
    expect(await checkWorkspaceDiskHeadroom({ path: "/x", env: { [ENV]: "50" }, statfs: statAt(60) })).not.toBeNull();
    expect(await checkWorkspaceDiskHeadroom({ path: "/x", env: { [ENV]: "0" }, statfs: statAt(100) })).toBeNull();
  });

  it("fails open when the volume cannot be read", async () => {
    const statfs = async () => { throw new Error("ENOSYS"); };
    expect(await checkWorkspaceDiskHeadroom({ path: "/x", env: {}, statfs })).toBeNull();
  });
});

describe("realizeExecutionWorkspace disk guard", () => {
  const roots: string[] = [];
  const savedEnv = process.env[ENV];
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
    while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true }).catch(() => {});
  });

  async function makeRepo() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup20840-"));
    roots.push(root);
    const repo = path.join(root, "repo");
    const git = (...args: string[]) =>
      execFileAsync("git", args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
    await git("init", "-q", "-b", "main", repo);
    await fs.writeFile(path.join(repo, "a"), "a\n");
    await git("-C", repo, "add", "-A");
    await git("-C", repo, "commit", "-qm", "c1");
    return repo;
  }

  const realize = (repo: string, identifier = "PAP-1") =>
    realizeExecutionWorkspace({
      base: { baseCwd: repo, source: "project_primary", projectId: "p", workspaceId: "w", repoUrl: null, repoRef: "main" },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" } },
      issue: { id: identifier, identifier, title: "Disk guard" },
      agent: { id: "a", name: "Agent", companyId: "c" },
    });

  it("refuses to create a worktree when the volume is over the limit, but reuses an existing one", async () => {
    const repo = await makeRepo();

    process.env[ENV] = "0";
    const created = await realize(repo);
    expect(created.created).toBe(true);

    // 0.001% is below any real volume's usage, so a fresh worktree must be refused...
    process.env[ENV] = "0.001";
    const refused = await realize(repo, "PAP-2").catch((error) => error);
    expect(refused).toBeInstanceOf(WorkspaceGitScanError);
    expect(refused.code).toBe(WORKSPACE_GIT_SCAN_ERROR_CODES.diskHeadroom);
    expect(refused.details).toMatchObject({ retryable: true, maxUsedPercent: 0.001 });
    await expect(fs.stat(path.join(repo, ".paperclip", "worktrees", "PAP-2-disk-guard"))).rejects.toThrow();

    // ...while the worktree that already exists keeps working.
    const reused = await realize(repo);
    expect(reused.created).toBe(false);
    expect(reused.worktreePath).toBe(created.worktreePath);
  });
});
