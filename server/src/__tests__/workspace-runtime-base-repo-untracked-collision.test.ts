import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  isQuarantinableBaseRepoPath,
  prepareBaseRepoForWorkspace,
} from "../services/workspace-runtime.ts";

// Base-repo hygiene must converge even when an untracked file in the base repo
// collides with a path that has since landed on the base ref.
//
// Production shape (Trading-Signal-Platform, 2026-08-24 onward): the base repo
// sits on main, clean of tracked modifications, 22 behind origin/main, holding a
// handful of untracked files an agent errand left behind. Two of those paths then
// merged upstream. `git merge --ff-only origin/main` refuses:
//
//   error: The following untracked working tree files would be overwritten by merge:
//   	apps/db/supabase/migrations/…sql
//   	scripts/backfill-….mjs
//
// Nothing removes them, so the same fast-forward is attempted and refused on every
// single dispatch: 1,035 recorded worktree_prepare failures in seven days, 98% of
// all worktree_prepare failures, and the base repo never advances again.
//
// Real git throughout: the defect is git's own refusal semantics plus the fact that
// untracked paths are deliberately excluded from the hygiene decision, so a mock
// would have to encode the very behaviour under test.

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
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
  return stdout.trim();
}

async function writeFile(repo: string, name: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
  await fs.writeFile(path.join(repo, name), body);
}

async function commit(repo: string, name: string, body = `${name}\n`): Promise<void> {
  await writeFile(repo, name, body);
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", name], repo);
}

const COLLIDING = [
  "apps/db/supabase/migrations/20260831000340_backfill.sql",
  "scripts/backfill-sentiment-history.mjs",
];
const INNOCENT = "docs/project-summary-2026-08-26-evening.md";

/**
 * The production shape: base repo on main, tracked-clean, behind origin/main, with
 * untracked files two of which have since landed upstream.
 */
async function makeUntrackedCollisionRepo(): Promise<{ root: string; work: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "base-repo-untracked-"));
  tempRoots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");

  await git(["init", "-q", "--bare", "-b", "main", origin], root);
  await git(["init", "-q", "-b", "main", seed], root);
  await commit(seed, "c1");
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main"], seed);

  await git(["clone", "-q", `file://${origin}`, work], root);

  // Upstream advances, and the agent's paths land in it.
  for (const name of COLLIDING) await commit(seed, name, `upstream version of ${name}\n`);
  await commit(seed, "c2");
  await git(["push", "-q", "origin", "main"], seed);

  // The base repo carries its own untracked copies plus one that never collides.
  for (const name of COLLIDING) await writeFile(work, name, `agent version of ${name}\n`);
  await writeFile(work, INNOCENT, "agent notes\n");

  await git(["fetch", "-q", "origin", "main"], work);
  return { root, work };
}

const prepare = (work: string) =>
  prepareBaseRepoForWorkspace({ repoRoot: work, configuredBaseRef: "main" });

describe("base repo hygiene with untracked paths that collide with the base ref", () => {
  it("the fixture really does reproduce git's refusal", async () => {
    // Guard the guard: if git ever stopped refusing, every assertion below would
    // pass vacuously.
    const { work } = await makeUntrackedCollisionRepo();
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], work)).toBe("main");
    expect(await git(["status", "--porcelain", "--untracked-files=no"], work)).toBe("");
    await expect(git(["merge", "--ff-only", "origin/main"], work)).rejects.toThrow(
      /untracked working tree files would be overwritten/,
    );
  });

  it("fast-forwards the base repo anyway", async () => {
    const { work } = await makeUntrackedCollisionRepo();

    const { warnings } = await prepare(work);

    expect(
      await git(["rev-parse", "HEAD"], work),
      `base repo did not advance; warnings were: ${JSON.stringify(warnings, null, 2)}`,
    ).toBe(await git(["rev-parse", "origin/main"], work));
  });

  it("converges — a second dispatch is a no-op, not the same refusal again", async () => {
    const { work } = await makeUntrackedCollisionRepo();
    await prepare(work);
    const { warnings } = await prepare(work);
    expect(warnings.filter((w) => /untracked working tree files/.test(w))).toEqual([]);
  });

  it("preserves the colliding files' contents rather than discarding them", async () => {
    const { work } = await makeUntrackedCollisionRepo();
    await prepare(work);

    const quarantineRoot = path.join(work, ".git", "paperclip-base-repo-quarantine");
    const quarantined = await execFileAsync("grep", ["-rl", "agent version of", quarantineRoot])
      .then(({ stdout }) => stdout.trim().split("\n").filter(Boolean))
      .catch(() => [] as string[]);
    expect(quarantined.length).toBe(COLLIDING.length);

    // The quarantine lives in the git directory, never the working tree — a
    // quarantine inside the tree would be a fresh untracked file, i.e. the next
    // thing capable of blocking a merge.
    expect(await git(["status", "--porcelain", "--untracked-files=all"], work))
      .toBe(`?? ${INNOCENT}`);
  });

  it("leaves untracked files that do not collide exactly where they are", async () => {
    const { work } = await makeUntrackedCollisionRepo();
    await prepare(work);
    expect(await fs.readFile(path.join(work, INNOCENT), "utf8")).toBe("agent notes\n");
  });
});

describe("what may be moved out of the base repo working tree", () => {
  // The agent worktrees live at <repoRoot>/.paperclip/worktrees and that directory
  // is untracked in at least one repo on this fleet. Moving one to unwedge a
  // fast-forward would trade a loud failure for a silent one, so `.paperclip` is
  // ineligible whatever the base ref contains.
  it("never touches .paperclip or .git", () => {
    expect(isQuarantinableBaseRepoPath(".paperclip/worktrees/SUP-1/src/index.ts")).toBe(false);
    expect(isQuarantinableBaseRepoPath(".paperclip")).toBe(false);
    expect(isQuarantinableBaseRepoPath(".git/config")).toBe(false);
  });

  it("never follows a path out of the repo", () => {
    expect(isQuarantinableBaseRepoPath("../outside.txt")).toBe(false);
    expect(isQuarantinableBaseRepoPath("apps/../../outside.txt")).toBe(false);
    expect(isQuarantinableBaseRepoPath("/etc/passwd")).toBe(false);
    expect(isQuarantinableBaseRepoPath("")).toBe(false);
  });

  it("allows the ordinary repository paths the incident was made of", () => {
    expect(isQuarantinableBaseRepoPath("apps/db/supabase/migrations/2026_x.sql")).toBe(true);
    expect(isQuarantinableBaseRepoPath("scripts/backfill.mjs")).toBe(true);
    expect(isQuarantinableBaseRepoPath(".gitignore")).toBe(true);
  });
});
