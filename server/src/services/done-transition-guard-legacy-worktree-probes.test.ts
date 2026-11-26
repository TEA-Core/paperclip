import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

  // The server's safe.directory list (GIT_CONFIG_* entries, global and system
  // configuration) is the one inherited setting the probes keep, so a workspace
  // owned by another uid is measured exactly when it was before; the forwarding
  // is driven in hardened-git-probe.test.ts.
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
});

// SUP-23163: the legacy probes run under the same hardened runner as the
// record_only probe. A probe that could not run safely or to completion reports
// `{ unverified: true }`, which the guard treats as a block (fail closed); a git
// that ran and could not answer still reports null (the fail-open contract).

function plantedScript(name: string, marker: string, body = ""): string {
  const script = path.join(root, name);
  writeFileSync(script, `#!/bin/sh\necho fired >> '${marker}'\n${body}`);
  chmodSync(script, 0o755);
  return script;
}

function repoAheadOfBase(): string {
  const repo = plainRepo("repo");
  git(repo, "branch", "base");
  writeFileSync(path.join(repo, "b.txt"), "one\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-qm", "fix(SUP-9): attributable");
  return repo;
}

describe("legacy probes run no repository-named filter driver (SUP-23163)", () => {
  it("measures a clean and a dirty worktree without running a required filter driver", async () => {
    const repo = plainRepo("repo");
    writeFileSync(path.join(repo, ".gitattributes"), "* filter=planted\n");
    git(repo, "add", ".gitattributes");
    git(repo, "commit", "-qm", "attributes");
    const marker = path.join(root, "marker");
    const planted = plantedScript("planted-filter.sh", marker, "cat\n");
    git(repo, "config", "filter.planted.clean", planted);
    git(repo, "config", "filter.planted.smudge", planted);
    git(repo, "config", "filter.planted.process", planted);
    git(repo, "config", "filter.planted.required", "true");
    // A changed mtime makes git re-read the unchanged file through the filter.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(repo, "a.txt"), later, later);
    expect(await worktreeHasUncommittedContent(repo)).toBe(false);
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    expect(await worktreeHasUncommittedContent(repo)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("legacy probes run no transport helper on a lazy fetch (SUP-23163)", () => {
  // A partial clone whose base commit is missing: reading the range makes git
  // fetch the object from the promisor remote. The helper records that it ran
  // and then hangs, as a hostile or unreachable remote would.
  function partialCloneMissingBase(remoteUrl: string, config: ReadonlyArray<readonly [string, string]> = []): string {
    const repo = repoAheadOfBase();
    const baseSha = git(repo, "rev-parse", "base");
    rmSync(path.join(repo, ".git", "objects", baseSha.slice(0, 2), baseSha.slice(2)));
    git(repo, "config", "core.repositoryformatversion", "1");
    git(repo, "config", "extensions.partialClone", "origin");
    git(repo, "config", "remote.origin.url", remoteUrl);
    git(repo, "config", "remote.origin.promisor", "true");
    for (const [key, value] of config) git(repo, "config", key, value);
    return repo;
  }

  async function expectNoHelperRan(repo: string, marker: string): Promise<void> {
    const started = performance.now();
    expect(await countIssueAttributableCommits(repo, "base", "SUP-9")).toBeNull();
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(existsSync(marker)).toBe(false);
  }

  for (const variable of ["GIT_SSH_COMMAND", "GIT_SSH"] as const) {
    it(`does not run an inherited ${variable}`, async () => {
      const marker = path.join(root, "marker");
      const helper = plantedScript("helper.sh", marker, "sleep 30\n");
      const repo = partialCloneMissingBase("ssh://example.invalid/repo.git");
      await withEnv({ [variable]: helper }, () => expectNoHelperRan(repo, marker));
    }, 60_000);
  }

  it("does not run an inherited GIT_PROXY_COMMAND", async () => {
    const marker = path.join(root, "marker");
    const helper = plantedScript("helper.sh", marker, "sleep 30\n");
    const repo = partialCloneMissingBase("git://example.invalid/repo.git");
    await withEnv({ GIT_PROXY_COMMAND: helper }, () => expectNoHelperRan(repo, marker));
  }, 60_000);

  it("does not run the repository's own core.sshCommand", async () => {
    const marker = path.join(root, "marker");
    const helper = plantedScript("helper.sh", marker, "sleep 30\n");
    const repo = partialCloneMissingBase("ssh://example.invalid/repo.git", [["core.sshCommand", helper]]);
    await expectNoHelperRan(repo, marker);
  }, 60_000);

  it("does not run the repository's own promisor upload-pack helper", async () => {
    const marker = path.join(root, "marker");
    const helper = plantedScript("helper.sh", marker, "sleep 30\n");
    const remote = path.join(root, "remote");
    mkdirSync(remote);
    const repo = partialCloneMissingBase(remote, [["remote.origin.uploadpack", helper]]);
    await expectNoHelperRan(repo, marker);
  }, 60_000);
});

describe("legacy probes are bounded by a timeout and fail closed on it (SUP-23163)", () => {
  // The repository's own configuration names an include that blocks until
  // something writes the FIFO. Nothing does, so git never finishes by itself.
  it("kills a worktree status and an ahead-of-base count that do not finish and reports both unverified", async () => {
    const repo = repoAheadOfBase();
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    const fifo = path.join(root, "blocking-include");
    execFileSync("mkfifo", [fifo]);
    git(repo, "config", "include.path", fifo);
    const started = performance.now();
    const [dirty, counts] = await Promise.all([
      worktreeHasUncommittedContent(repo),
      countIssueAttributableCommits(repo, "base", "SUP-9"),
    ]);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(dirty).toMatchObject({ unverified: true, reason: expect.stringContaining("timed out") });
    expect(counts).toMatchObject({ unverified: true, reason: expect.stringContaining("timed out") });
  }, 70_000);
});

describe("legacy probes fail closed on an inherited GIT_COMMON_DIR or GIT_OBJECT_DIRECTORY (SUP-23163)", () => {
  for (const variable of ["GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"] as const) {
    it(`reports both probes unverified when the server inherits ${variable}`, async () => {
      const repo = repoAheadOfBase();
      writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
      const other = plainRepo("other");
      const value = variable === "GIT_COMMON_DIR" ? path.join(other, ".git") : path.join(other, ".git", "objects");
      await withEnv({ [variable]: value }, async () => {
        expect(await worktreeHasUncommittedContent(repo)).toMatchObject({
          unverified: true,
          reason: expect.stringContaining(variable),
        });
        expect(await countIssueAttributableCommits(repo, "base", "SUP-9")).toMatchObject({
          unverified: true,
          reason: expect.stringContaining(variable),
        });
      });
    });
  }
});

describe("legacy status probe keeps the git status --porcelain answer for ordinary worktrees (SUP-23163)", () => {
  function porcelainIsDirty(repo: string): boolean {
    return git(repo, "status", "--porcelain").length > 0;
  }

  it("agrees with git status --porcelain on staged, untracked, ignored, excluded and deleted content", async () => {
    const repo = plainRepo("repo");
    writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore");
    const states: Array<[string, () => void]> = [
      ["clean", () => {}],
      ["ignored file", () => writeFileSync(path.join(repo, "ignored.log"), "x\n")],
      ["info/exclude rule", () => {
        writeFileSync(path.join(repo, ".git", "info", "exclude"), "excluded.tmp\n");
        writeFileSync(path.join(repo, "excluded.tmp"), "x\n");
      }],
      ["untracked file in a new directory", () => {
        mkdirSync(path.join(repo, "notes"));
        writeFileSync(path.join(repo, "notes", "draft.md"), "x\n");
      }],
      ["staged change", () => {
        rmSync(path.join(repo, "notes"), { recursive: true });
        writeFileSync(path.join(repo, "a.txt"), "staged\n");
        git(repo, "add", "a.txt");
      }],
      ["deleted file", () => {
        git(repo, "reset", "-q", "--hard");
        rmSync(path.join(repo, "a.txt"));
      }],
    ];
    for (const [name, apply] of states) {
      apply();
      expect({ name, dirty: await worktreeHasUncommittedContent(repo) }).toEqual({ name, dirty: porcelainIsDirty(repo) });
    }
  });

  it("measures a linked worktree against its own index", async () => {
    const repo = plainRepo("repo");
    const linked = path.join(root, "linked");
    git(repo, "worktree", "add", "-q", "-b", "SUP-9-work", linked);
    expect(await worktreeHasUncommittedContent(linked)).toBe(false);
    writeFileSync(path.join(linked, "new.txt"), "x\n");
    expect(await worktreeHasUncommittedContent(linked)).toBe(true);
    expect(await worktreeHasUncommittedContent(repo)).toBe(false);
  });

  it("reports a worktree with a submodule unverified: its status would run the submodule's own configuration", async () => {
    const sub = plainRepo("sub");
    const repo = plainRepo("repo");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    git(repo, "commit", "-qm", "add submodule");
    expect(await worktreeHasUncommittedContent(repo)).toMatchObject({ unverified: true });
  });
});

describe("legacy status probe fails closed when it cannot build its snapshot safely (SUP-23163)", () => {
  it("reports a dirty worktree whose info/exclude is a symlink unverified", async () => {
    const repo = plainRepo("repo");
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    const target = path.join(root, "exclude-target");
    writeFileSync(target, "a.txt\n");
    const exclude = path.join(repo, ".git", "info", "exclude");
    rmSync(exclude, { force: true });
    symlinkSync(target, exclude);
    expect(await worktreeHasUncommittedContent(repo)).toMatchObject({
      unverified: true,
      reason: expect.stringContaining("info/exclude"),
    });
  });

  it("reports a dirty worktree whose index is a FIFO unverified", async () => {
    const repo = plainRepo("repo");
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    const index = path.join(repo, ".git", "index");
    rmSync(index);
    execFileSync("mkfifo", [index]);
    expect(await worktreeHasUncommittedContent(repo)).toMatchObject({
      unverified: true,
      reason: expect.stringContaining("index"),
    });
  });
});
