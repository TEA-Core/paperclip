import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareBaseRepoForWorkspace,
  resolveBaseRepoHygieneDecision,
} from "../services/workspace-runtime.ts";

// SUP-13857 — base-repo hygiene must not publish a divergence count it cannot compute.
//
// `git rev-list --left-right --count A...B` does NOT fail when there is no merge
// base. It silently degenerates to counting BOTH WHOLE HISTORIES. On the
// Trading-Signal-Platform base repo (2026-08-24) that produced "2519 ahead / 137
// behind" where the truth was 22 ahead / 349 behind. Both numbers land > 0, which
// classifies the repo `diverged` — and `diverged` by design never resets, so the
// base repo drifts permanently and no dispatch can recover it.
//
// The fixtures below build a real severed-ancestry repo rather than mocking git,
// because the whole defect is a git behaviour (silent degeneration) that a mock
// would have to encode — and encoding it is assuming the very thing under test.

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

async function commit(repo: string, name: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", name], repo);
}

type Fixture = { root: string; origin: string; work: string };

/**
 * A base repo whose ancestry to origin/main is SEVERED by a shallow graft.
 *
 * Sequence matters: clone at depth 1, commit locally, let origin advance, then
 * fetch at depth 1 again. The second shallow fetch brings a new tip with its own
 * graft, so the two tips share no visible ancestor even though they really do.
 */
async function makeSeveredShallowRepo(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup13857-"));
  tempRoots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");

  await git(["init", "-q", "--bare", "-b", "main", origin], root);
  await git(["init", "-q", "-b", "main", seed], root);
  for (const n of ["c1", "c2", "c3", "c4", "c5"]) await commit(seed, n);
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main"], seed);

  await git(["clone", "-q", "--depth=1", `file://${origin}`, work], root);
  for (const n of ["local6", "local7"]) await commit(work, n);

  for (const n of ["c8", "c9", "c10"]) await commit(seed, n);
  await git(["push", "-q", "origin", "main"], seed);
  await git(["fetch", "-q", "--depth=1", "origin", "main"], work);

  return { root, origin, work };
}

/** The same divergence shape, but with complete history. This is the control. */
async function makeHealthyDivergedRepo(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup13857-ok-"));
  tempRoots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");

  await git(["init", "-q", "--bare", "-b", "main", origin], root);
  await git(["init", "-q", "-b", "main", seed], root);
  for (const n of ["c1", "c2", "c3", "c4", "c5"]) await commit(seed, n);
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main"], seed);

  await git(["clone", "-q", `file://${origin}`, work], root);
  for (const n of ["local6", "local7"]) await commit(work, n);

  for (const n of ["c8", "c9", "c10"]) await commit(seed, n);
  await git(["push", "-q", "origin", "main"], seed);
  await git(["fetch", "-q", "origin", "main"], work);

  return { root, origin, work };
}

async function prepare(work: string) {
  return await prepareBaseRepoForWorkspace({ repoRoot: work, configuredBaseRef: "main" });
}

const shallowWarning = (warnings: string[]) =>
  warnings.find((w) => w.includes("indeterminate (shallow)"));
const divergedWarning = (warnings: string[]) => warnings.find((w) => w.includes("has diverged from"));

describe("base repo hygiene on a shallow repo with severed ancestry (SUP-13857)", () => {
  it("the fixture really does reproduce the silent whole-history degeneration", async () => {
    // Guard the guard. If a future git stops degenerating, or the fixture stops
    // severing ancestry, every assertion below would pass vacuously.
    const { work } = await makeSeveredShallowRepo();
    expect(await git(["rev-parse", "--is-shallow-repository"], work)).toBe("true");

    await expect(git(["merge-base", "HEAD", "origin/main"], work)).rejects.toThrow();

    const [behind, ahead] = (await git(
      ["rev-list", "--left-right", "--count", "origin/main...HEAD"],
      work,
    )).split(/\s+/).map(Number);
    // The truth is 2 ahead. git reports otherwise, and BOTH numbers land > 0,
    // which is precisely what latches the `diverged` classification.
    expect(ahead).not.toBe(2);
    expect(ahead).toBeGreaterThan(0);
    expect(behind).toBeGreaterThan(0);
  });

  it("warns 'indeterminate (shallow)' and publishes NO ahead/behind integers", async () => {
    const { work, origin } = await makeSeveredShallowRepo();
    // Break the remote so the bounded deepen cannot succeed and the repo stays
    // shallow — the unreachable-remote case, not a synthetic one.
    await git(["remote", "set-url", "origin", `${origin}-does-not-exist`], work);

    const { warnings } = await prepare(work);
    const warning = shallowWarning(warnings);

    expect(warning, `warnings were: ${JSON.stringify(warnings, null, 2)}`).toBeDefined();
    expect(warning).toContain("indeterminate (shallow)");

    // Acceptance 1 + 4: not "smaller numbers", NO numbers. The 2519/137 shape must
    // be unreachable, so assert on the ahead/behind phrasing itself.
    expect(warning).not.toMatch(/\d+\s*(commit\(s\)\s*)?ahead/i);
    expect(warning).not.toMatch(/\d+\s*(commit\(s\)\s*)?behind/i);
    expect(divergedWarning(warnings)).toBeUndefined();
  });

  it("names the graft commits from .git/shallow", async () => {
    const { work, origin } = await makeSeveredShallowRepo();
    await git(["remote", "set-url", "origin", `${origin}-does-not-exist`], work);
    const grafts = (await fs.readFile(path.join(work, ".git", "shallow"), "utf8"))
      .split("\n").map((l) => l.trim()).filter(Boolean);
    expect(grafts.length).toBeGreaterThan(0);

    const warning = shallowWarning((await prepare(work)).warnings);
    for (const sha of grafts) expect(warning).toContain(sha.slice(0, 12));
  });

  it("a failed deepen is non-fatal — it warns and the dispatch still gets its baseRef", async () => {
    const { work, origin } = await makeSeveredShallowRepo();
    await git(["remote", "set-url", "origin", `${origin}-does-not-exist`], work);

    // Acceptance 5: resolves rather than throws, and still returns a usable baseRef.
    const result = await prepare(work);
    expect(result.baseRef).toBeTruthy();
    expect(result.warnings.some((w) => w.includes("could not be deepened"))).toBe(true);
  });

  it("deepens when it can, then reports the TRUE counts on the normal path", async () => {
    // Acceptance 2. Remote left reachable, so `git fetch --unshallow` restores the
    // real ancestry and the ordinary diverged path takes over with honest numbers.
    const { work } = await makeSeveredShallowRepo();

    const { warnings } = await prepare(work);
    expect(await git(["rev-parse", "--is-shallow-repository"], work)).toBe("false");
    expect(shallowWarning(warnings)).toBeUndefined();

    const warning = divergedWarning(warnings);
    expect(warning, `warnings were: ${JSON.stringify(warnings, null, 2)}`).toBeDefined();
    expect(warning).toContain("2 ahead, 3 behind");
    expect(warning).toContain("local7");
  });
});

describe("base repo hygiene on a complete repo is unchanged (SUP-13857)", () => {
  it("still reports diverged with true counts and the same message shape", async () => {
    // Acceptance 3: the common path must not move.
    const { work } = await makeHealthyDivergedRepo();
    const { warnings } = await prepare(work);

    expect(shallowWarning(warnings)).toBeUndefined();
    const warning = divergedWarning(warnings);
    expect(warning).toBeDefined();
    expect(warning).toContain("2 ahead, 3 behind");
    expect(warning).toContain("Local commits preserved — no reset performed.");
  });

  it("reports ok, with no shallow warning, when HEAD is exactly the base ref", async () => {
    const { root, origin } = await makeHealthyDivergedRepo();
    const clean = path.join(root, "clean");
    await git(["clone", "-q", `file://${origin}`, clean], root);

    const { warnings } = await prepare(clean);
    expect(shallowWarning(warnings)).toBeUndefined();
    expect(divergedWarning(warnings)).toBeUndefined();
  });
});

describe("resolveBaseRepoHygieneDecision divergence computability (SUP-13857)", () => {
  const clean = {
    currentBranch: "main",
    defaultRef: "main",
    dirtyTrackedPathCount: 0,
    unmergedPathCount: 0,
    headSha: "aaa",
    baseRefSha: "bbb",
  };

  it("returns indeterminate instead of diverged when the counts are not computable", () => {
    const decision = resolveBaseRepoHygieneDecision({
      ...clean,
      // The exact shape observed on the TSP base repo.
      aheadCount: 2519,
      behindCount: 137,
      aheadCommitSubjects: ["whatever"],
      divergenceComputable: false,
      graftCommits: ["1111111111111111111111111111111111111111"],
    });
    expect(decision.action).toBe("indeterminate");
    if (decision.action === "indeterminate") {
      expect(decision.graftCommits).toEqual(["1111111111111111111111111111111111111111"]);
    }
  });

  it("defaults to computable, so every existing caller is unaffected", () => {
    const decision = resolveBaseRepoHygieneDecision({
      ...clean,
      aheadCount: 3,
      behindCount: 4,
      aheadCommitSubjects: ["s"],
    });
    expect(decision).toEqual({
      action: "diverged",
      aheadCount: 3,
      behindCount: 4,
      aheadCommitSubjects: ["s"],
    });
  });

  it("a genuine fast-forward inside the shallow window still wins over indeterminate", () => {
    // merge-base --is-ancestor succeeding proves ancestry IS intact for that pair,
    // so refusing to fast-forward would be its own false negative.
    const decision = resolveBaseRepoHygieneDecision({
      ...clean,
      headBehindBaseRef: true,
      divergenceComputable: false,
    });
    expect(decision).toEqual({ action: "fastForward" });
  });

  it("restore reasons still outrank indeterminate — dirt is actionable either way", () => {
    const decision = resolveBaseRepoHygieneDecision({
      ...clean,
      dirtyTrackedPathCount: 2,
      divergenceComputable: false,
    });
    expect(decision.action).toBe("restore");
  });

  it("returns indeterminate with an empty graft list when there is simply no merge base", () => {
    const decision = resolveBaseRepoHygieneDecision({ ...clean, divergenceComputable: false });
    expect(decision).toEqual({ action: "indeterminate", graftCommits: [] });
  });
});
