import { describe, expect, it } from "vitest";
import { terminalCleanupBranchMismatchIsLanded } from "../services/execution-workspaces.ts";

// Error and unknown-value paths of the terminal-cleanup branch-mismatch check.
// The real-git sweep cases live in execution-workspaces-service.test.ts.
describe("terminalCleanupBranchMismatchIsLanded", () => {
  const HEAD = "a7fc52fbe2a7fc52fbe2a7fc52fbe2a7fc52fbe2";
  const exitError = (code: unknown) => Object.assign(new Error(`git exited ${String(code)}`), { code });

  function fakeGit(responses: {
    revParse: () => Promise<{ stdout: string }>;
    revList?: () => Promise<{ stdout: string }>;
  }) {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return responses.revParse();
      if (args[0] === "rev-list" && responses.revList) return responses.revList();
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    return { git, calls };
  }

  const branchGone = () => Promise.reject(exitError(1));
  const onRemotes = async () => ({ stdout: "0\n" });

  function check(
    git: (args: string[]) => Promise<{ stdout: string }>,
    overrides: { isMergedIntoBase?: boolean | null; mergedPullRequestHeadShas?: string[] } = {},
  ) {
    return terminalCleanupBranchMismatchIsLanded({
      recordedBranchName: "fm/recorded-delivery-branch",
      headSha: HEAD,
      isMergedIntoBase: overrides.isMergedIntoBase === undefined ? true : overrides.isMergedIntoBase,
      mergedPullRequestHeadShas: overrides.mergedPullRequestHeadShas ?? [],
      git,
    });
  }

  it("tolerates a gone recorded branch when HEAD is an ancestor of the base ref and on a remote", async () => {
    const { git, calls } = fakeGit({ revParse: branchGone, revList: onRemotes });
    await expect(check(git)).resolves.toBe(true);
    expect(calls).toEqual([
      ["rev-parse", "--verify", "--quiet", "refs/heads/fm/recorded-delivery-branch"],
      ["rev-list", "--count", "HEAD", "--not", "--remotes"],
    ]);
  });

  it("tolerates a HEAD that equals a merged PR head when it is not an ancestor of the base ref", async () => {
    const { git } = fakeGit({ revParse: branchGone, revList: onRemotes });
    await expect(check(git, { isMergedIntoBase: false, mergedPullRequestHeadShas: [HEAD] })).resolves.toBe(true);
  });

  it.each([
    ["not an ancestor", false],
    ["ancestry unknown", null],
  ] as const)("refuses when HEAD is %s and matches no merged PR head", async (_label, isMergedIntoBase) => {
    const { git, calls } = fakeGit({ revParse: branchGone, revList: onRemotes });
    await expect(check(git, {
      isMergedIntoBase,
      mergedPullRequestHeadShas: ["1111111111111111111111111111111111111111"],
    })).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses when the recorded branch still exists as a local ref", async () => {
    const { git } = fakeGit({ revParse: async () => ({ stdout: `${HEAD}\n` }), revList: onRemotes });
    await expect(check(git)).resolves.toBe(false);
  });

  it.each([
    ["a fatal git exit", exitError(128)],
    ["a spawn error", exitError("ENOENT")],
    ["an error without an exit code", new Error("boom")],
  ])("refuses when the recorded-branch probe fails with %s", async (_label, error) => {
    const { git, calls } = fakeGit({ revParse: () => Promise.reject(error), revList: onRemotes });
    await expect(check(git)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a commit missing from every remote", async () => ({ stdout: "1\n" })],
    ["empty output", async () => ({ stdout: "" })],
    ["a failed remote check", () => Promise.reject(exitError(128))],
  ])("refuses on %s", async (_label, revList) => {
    const { git } = fakeGit({ revParse: branchGone, revList });
    await expect(check(git)).resolves.toBe(false);
  });
});
