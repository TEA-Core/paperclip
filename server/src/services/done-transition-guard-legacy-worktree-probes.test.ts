import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countIssueAttributableCommits,
  worktreeHasUncommittedContent,
} from "./done-transition-guard.js";

// SUP-22880: the repository_delivery local-worktree probes (the dirty-worktree
// and ahead-of-base signals), driven through the real guard functions against
// real repositories. Both fail open on null, so every case that must still be
// measured asserts a concrete value, not "not null".

const fixtureEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    env: fixtureEnv,
    stdio: "pipe",
  }).toString().trim();
}

let root: string;

function plainRepo(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  return dir;
}

// The host's own system/global git config is shut out by default: CI images ship
// `safe.directory = *`, which would mark every repository safe.
async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const vars = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...overrides };
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "paperclip-legacy-worktree-probes-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("worktreeHasUncommittedContent (repository_delivery dirty-worktree signal)", () => {
  it("reports a dirty worktree and a clean one", async () => {
    const repo = plainRepo("repo");
    expect(await worktreeHasUncommittedContent(repo)).toBe(false);
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    expect(await worktreeHasUncommittedContent(repo)).toBe(true);
  });

  it("ignores GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE inherited by the server, so a clean repository cannot mask a dirty worktree", async () => {
    const dirty = plainRepo("dirty");
    writeFileSync(path.join(dirty, "a.txt"), "undelivered\n");
    const clean = plainRepo("clean");
    await withEnv(
      {
        GIT_DIR: path.join(clean, ".git"),
        GIT_WORK_TREE: clean,
        GIT_INDEX_FILE: path.join(clean, ".git", "index"),
      },
      async () => {
        expect(await worktreeHasUncommittedContent(dirty)).toBe(true);
        expect(await worktreeHasUncommittedContent(clean)).toBe(false);
      },
    );
  });

  it("does not execute a planted core.fsmonitor or hook, and still measures", async () => {
    const repo = plainRepo("repo");
    const marker = path.join(root, "marker");
    const planted = path.join(root, "planted.sh");
    writeFileSync(planted, `#!/bin/sh\necho fired >> '${marker}'\ncat\n`);
    chmodSync(planted, 0o755);
    const hooks = path.join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, "post-index-change"), `#!/bin/sh\necho fired >> '${marker}'\n`);
    chmodSync(path.join(hooks, "post-index-change"), 0o755);
    git(repo, "config", "core.fsmonitor", planted);
    git(repo, "config", "core.hooksPath", hooks);
    writeFileSync(path.join(repo, "b.txt"), "untracked\n");
    expect(await worktreeHasUncommittedContent(repo)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  // GIT_TEST_ASSUME_DIFFERENT_OWNER makes git treat every repository as owned by
  // another uid, the state a workspace shared across uids is in.
  it("measures a workspace owned by another uid when safe.directory arrives through GIT_CONFIG_COUNT/KEY/VALUE", async () => {
    const repo = plainRepo("repo");
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    await withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" }, async () => {
      expect(await worktreeHasUncommittedContent(repo)).toBeNull();
    });
    await withEnv(
      {
        GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: repo,
      },
      async () => {
        expect(await worktreeHasUncommittedContent(repo)).toBe(true);
      },
    );
  });
});

describe("countIssueAttributableCommits (repository_delivery ahead-of-base signal)", () => {
  function repoWithCommitsAhead() {
    const repo = plainRepo("repo");
    git(repo, "branch", "base");
    writeFileSync(path.join(repo, "b.txt"), "one\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-qm", "fix(SUP-9): attributable");
    writeFileSync(path.join(repo, "c.txt"), "two\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-qm", "unrelated work");
    return repo;
  }

  it("counts commits ahead of the base and those naming the issue", async () => {
    expect(await countIssueAttributableCommits(repoWithCommitsAhead(), "base", "SUP-9")).toEqual({
      aheadCount: 2,
      attributableCount: 1,
    });
  });

  it("ignores inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE that point at another repository", async () => {
    const repo = repoWithCommitsAhead();
    const other = plainRepo("other");
    await withEnv(
      {
        GIT_DIR: path.join(other, ".git"),
        GIT_WORK_TREE: other,
        GIT_INDEX_FILE: path.join(other, ".git", "index"),
      },
      async () => {
        expect(await countIssueAttributableCommits(repo, "base", "SUP-9")).toEqual({
          aheadCount: 2,
          attributableCount: 1,
        });
      },
    );
  });

  it("measures a workspace owned by another uid when safe.directory arrives through GIT_CONFIG_COUNT/KEY/VALUE", async () => {
    const repo = repoWithCommitsAhead();
    await withEnv(
      {
        GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: repo,
      },
      async () => {
        expect(await countIssueAttributableCommits(repo, "base", "SUP-9")).toEqual({
          aheadCount: 2,
          attributableCount: 1,
        });
      },
    );
  });
});

describe("legacy probes carry no timeout (recorded owner decision)", () => {
  // The repository's own configuration names an include that blocks until
  // something writes the FIFO, so git cannot finish until the test releases it,
  // 18 seconds in: past the 15 seconds every close-gating probe gets. A legacy
  // probe with a timeout would have been killed and returned null into its
  // fail-open branch.
  it("a worktree status and an ahead-of-base count that outlast the close-gating default still complete and report", async () => {
    const repo = plainRepo("repo");
    git(repo, "branch", "base");
    writeFileSync(path.join(repo, "b.txt"), "one\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-qm", "fix(SUP-9): attributable");
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    const fifo = path.join(root, "blocking-include");
    execFileSync("mkfifo", [fifo]);
    git(repo, "config", "include.path", fifo);
    const releaser = spawn("sh", ["-c", `sleep 18; while :; do : > '${fifo}'; done`], { stdio: "ignore" });
    try {
      const [dirty, counts] = await Promise.all([
        worktreeHasUncommittedContent(repo),
        countIssueAttributableCommits(repo, "base", "SUP-9"),
      ]);
      expect(dirty).toBe(true);
      expect(counts).toEqual({ aheadCount: 1, attributableCount: 1 });
    } finally {
      releaser.kill();
    }
  }, 70_000);
});
