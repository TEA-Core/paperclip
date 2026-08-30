import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBaseRepoForWorkspace } from "../services/workspace-runtime.ts";

// SUP-13858 — auto-reset a diverged base repo when every ahead commit is already
// upstream by patch-id.
//
// `diverged` never resets, by design: resetting over real local work would be data
// loss. But the rule has no escape hatch, so a base repo whose ahead commits are ALL
// duplicates is frozen permanently. In the motivating incident 20 of 22 ahead commits
// were duplicates or belonged to a cancelled issue and ZERO were unshipped, and the
// repo stayed stuck for 16 days.
//
// Because the only thing this feature does is authorise discarding commits, the tests
// are weighted towards the refusals: a unique commit, a merge commit, and a missing
// merge base must each leave the repo untouched with the old warning verbatim.

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
let pathBackup: string | undefined;

afterEach(async () => {
  if (pathBackup !== undefined) {
    process.env.PATH = pathBackup;
    pathBackup = undefined;
  }
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

/**
 * A commit whose DIFF is byte-identical wherever it is applied, so the patch-ids match
 * — but whose commit MESSAGE differs between the two repos, so the shas do not.
 *
 * The message argument is load-bearing. With identical author, committer, tree, parent
 * and message, git produces the identical sha in both repos within the same second, and
 * the clone's history becomes a literal prefix of origin's: 0 ahead, and the whole
 * fixture silently tests the fast-forward path instead of the diverged one.
 */
async function commit(repo: string, name: string, message = name): Promise<void> {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", message], repo);
}

type Fixture = { root: string; origin: string; seed: string; work: string };

async function makeOriginAndClone(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup13858-"));
  tempRoots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");

  await git(["init", "-q", "--bare", "-b", "main", origin], root);
  await git(["init", "-q", "-b", "main", seed], root);
  for (const n of ["c1", "c2", "c3"]) await commit(seed, n);
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main"], seed);
  await git(["clone", "-q", `file://${origin}`, work], root);

  return { root, origin, seed, work };
}

/** Advance origin, then refresh the clone's remote-tracking ref. */
async function publish(f: Fixture): Promise<void> {
  await git(["push", "-q", "origin", "main"], f.seed);
  await git(["fetch", "-q", "origin", "main"], f.work);
}

async function prepare(work: string) {
  return await prepareBaseRepoForWorkspace({ repoRoot: work, configuredBaseRef: "main" });
}

const resetWarning = (warnings: string[]) => warnings.find((w) => w.includes("was reset to"));
const divergedWarning = (warnings: string[]) => warnings.find((w) => w.includes("has diverged from"));

describe("base repo auto-reset when every ahead commit is already upstream (SUP-13858)", () => {
  it("resets, and pins the prior tip on a rescue ref that still resolves afterwards", async () => {
    const f = await makeOriginAndClone();

    // Same change committed in both places: different sha, identical diff, so identical
    // patch-id. This is the shape the whole feature is about.
    await commit(f.work, "dup1", "local dup1");
    await commit(f.work, "dup2", "local dup2");
    await commit(f.seed, "dup1", "upstream dup1");
    await commit(f.seed, "dup2", "upstream dup2");
    await commit(f.seed, "c4");
    await publish(f);

    const priorTip = await git(["rev-parse", "HEAD"], f.work);
    const originMain = await git(["rev-parse", "origin/main"], f.work);
    expect(priorTip).not.toBe(originMain);

    const { warnings } = await prepare(f.work);

    // Acceptance 1: the reset happened.
    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);

    const warning = resetWarning(warnings);
    expect(warning, `warnings were: ${JSON.stringify(warnings, null, 2)}`).toBeDefined();
    expect(warning).toContain("all 2 ahead commit(s) were already upstream");
    expect(warning).toContain(priorTip.slice(0, 12));
    expect(divergedWarning(warnings)).toBeUndefined();

    // Acceptance 3: the rescue ref named in the warning resolves to the PRE-reset tip.
    const refMatch = warning?.match(/refs\/paperclip\/rescue\/base-repo\/[^\s]+\/head/);
    expect(refMatch, `no rescue ref in: ${warning}`).not.toBeNull();
    expect(await git(["rev-parse", refMatch![0]], f.work)).toBe(priorTip);

    // And the commits are genuinely still reachable, not just the ref existing.
    expect(await git(["log", "--format=%s", "-1", refMatch![0]], f.work)).toBe("local dup2");
  });

  it("bounds the patch-id windows with an explicit --max-count on BOTH sides", async () => {
    // Acceptance 4. Asserted on the real argv, via a git shim on PATH, because "it is
    // bounded" is a safety property and reading it off the source would not prove the
    // running command carries it.
    const f = await makeOriginAndClone();
    await commit(f.work, "dup1", "local dup1");
    await commit(f.seed, "dup1", "upstream dup1");
    await commit(f.seed, "c4");
    await publish(f);

    const binDir = path.join(f.root, "shim");
    const logFile = path.join(f.root, "git-argv.log");
    await fs.mkdir(binDir, { recursive: true });
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    await fs.writeFile(
      path.join(binDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    await fs.chmod(path.join(binDir, "git"), 0o755);

    pathBackup = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    await prepare(f.work);
    process.env.PATH = pathBackup;
    pathBackup = undefined;

    const argv = await fs.readFile(logFile, "utf8");
    const revLists = argv.split("\n").filter((line) => line.startsWith("rev-list --max-count="));

    // The ahead side and the upstream side are separately capped. The upstream window
    // is anchored on the resolved merge-base sha, not on a ref, so it cannot silently
    // widen if the ref moves.
    expect(revLists.some((l) => /rev-list --max-count=\d+ origin\/main\.\.HEAD$/.test(l))).toBe(true);
    expect(
      revLists.some((l) => /rev-list --max-count=\d+ [0-9a-f]{40}\.\.origin\/main$/.test(l)),
      `rev-list calls were:\n${revLists.join("\n")}`,
    ).toBe(true);
    // No rev-list that ENUMERATES commits is unbounded. `--count` is excluded on
    // purpose: it returns two integers rather than a commit list, it predates this
    // change, and it is not what feeds the patch-id comparison.
    const unboundedEnumerations = argv
      .split("\n")
      .filter((l) => l.startsWith("rev-list "))
      .filter((l) => !l.includes("--max-count") && !l.includes("--count"));
    expect(unboundedEnumerations, `unbounded rev-list enumerations: ${unboundedEnumerations.join(" | ")}`).toEqual([]);
  });
});

describe("base repo auto-reset refuses whenever duplication is not proven (SUP-13858)", () => {
  const verbatim = (repoRoot: string, ahead: number, behind: number, subjects: string) =>
    `Base repository at ${repoRoot} has diverged from origin/main: ` +
    `${ahead} ahead, ${behind} behind. ` +
    `Ahead commits: ${subjects}. Local commits preserved — no reset performed.`;

  it("a single unique ahead commit blocks the reset and emits the old warning verbatim", async () => {
    // Acceptance 2. One unique commit among duplicates must veto the whole reset.
    const f = await makeOriginAndClone();
    await commit(f.work, "dup1", "local dup1");
    await commit(f.work, "only-here");
    await commit(f.seed, "dup1", "upstream dup1");
    await commit(f.seed, "c4");
    await publish(f);

    const priorTip = await git(["rev-parse", "HEAD"], f.work);
    const { warnings } = await prepare(f.work);

    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);
    expect(resetWarning(warnings)).toBeUndefined();
    const warning = divergedWarning(warnings);
    expect(warning, `warnings were: ${JSON.stringify(warnings, null, 2)}`).toBeDefined();
    expect(warning?.startsWith(verbatim(f.work, 2, 2, "only-here, local dup1"))).toBe(true);
    expect(await git(["for-each-ref", "refs/paperclip/rescue"], f.work)).toBe("");
  });

  it("fails closed on a merge commit — no single patch-id means UNIQUE, never duplicate", async () => {
    // Acceptance 5. Every other ahead commit here IS a proven duplicate, so the merge
    // commit is the only thing standing between this repo and a reset.
    const f = await makeOriginAndClone();
    const base = await git(["rev-parse", "HEAD"], f.work);

    await commit(f.work, "dupA", "local dupA");
    await git(["switch", "-q", "-c", "side", base], f.work);
    await commit(f.work, "dupB", "local dupB");
    await git(["switch", "-q", "main"], f.work);
    await git(["merge", "-q", "--no-ff", "-m", "merge side", "side"], f.work);

    await commit(f.seed, "dupA", "upstream dupA");
    await commit(f.seed, "dupB", "upstream dupB");
    await commit(f.seed, "c4");
    await publish(f);

    const priorTip = await git(["rev-parse", "HEAD"], f.work);
    const { warnings } = await prepare(f.work);

    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);
    expect(resetWarning(warnings)).toBeUndefined();
    expect(divergedWarning(warnings)).toBeDefined();
    expect(await git(["for-each-ref", "refs/paperclip/rescue"], f.work)).toBe("");
  });

  it("leaves a clean, non-diverged repo completely alone", async () => {
    // The common path must not acquire a reset it never had.
    const f = await makeOriginAndClone();
    const tip = await git(["rev-parse", "HEAD"], f.work);

    const { warnings } = await prepare(f.work);

    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(tip);
    expect(resetWarning(warnings)).toBeUndefined();
    expect(divergedWarning(warnings)).toBeUndefined();
    expect(await git(["for-each-ref", "refs/paperclip/rescue"], f.work)).toBe("");
  });

  it("does not reset a repo that is only behind — that path fast-forwards, not resets", async () => {
    const f = await makeOriginAndClone();
    await commit(f.seed, "c4");
    await publish(f);

    const { warnings } = await prepare(f.work);

    expect(resetWarning(warnings)).toBeUndefined();
    expect(await git(["for-each-ref", "refs/paperclip/rescue"], f.work)).toBe("");
    expect(warnings.some((w) => w.includes("was fast-forwarded to"))).toBe(true);
  });
});
