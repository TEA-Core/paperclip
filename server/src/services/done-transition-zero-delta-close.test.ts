import { execFileSync, type SpawnOptions } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executionWorkspaces, issues, issueWorkProducts, projectWorkspaces } from "@paperclipai/db";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import {
  evaluateDoneTierDeclaration,
  type DoneTierDeclarationResult,
  TIER2_FORM,
  TIER2_RECORD_ONLY_FORM,
} from "./done-transition-guard.js";
import * as doneTransitionGuard from "./done-transition-guard.js";
import { zeroDeltaWorktreeRefusal } from "./hardened-git-probe.js";
import type * as MergeArming from "./merge-arming.js";
import { resolveGitHubToken } from "./github-credential.js";
import { resetZeroDeltaForgeCache } from "./zero-delta-forge-rule.js";

// SUP-24402: the zero-delta repository_delivery Tier 2 close, measured with
// real git against a real worktree. GitHub is a bare "origin" repository the
// worktree cannot write, answered through the same REST shapes the guard reads.

const mockGhFetch = vi.hoisted(() => vi.fn());
vi.mock("./github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: () => "https://api.github.com",
}));

vi.mock("./github-credential.js", () => ({
  resolveGitHubToken: vi.fn(async () => ({ token: "test-token", scope: "company", secretName: "GITHUB_TOKEN" })),
  resolveGitHubTokenCandidatesForRepo: vi.fn(async () => []),
}));

const mockResolveLinkedPullRequestsWithState = vi.hoisted(() => vi.fn());
vi.mock("./merge-arming.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MergeArming>()),
  resolveLinkedPullRequestsWithState: mockResolveLinkedPullRequestsWithState,
}));

// Fault injection at the process boundary, for the git answers a consistent
// repository never gives (zero ahead but "not an ancestor") and for a HEAD that
// moves while it is measured. `onGit` sees each probe git invocation's argv;
// returning "fail" replaces that process with one that exits 1.
const gitFault = vi.hoisted(() => ({ onGit: null as null | ((args: readonly string[]) => "fail" | void) }));
let plantDuringCommitsRead = false;
const pullRequestHeads: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options: SpawnOptions) =>
      gitFault.onGit?.(args) === "fail"
        ? actual.spawn("/bin/sh", ["-c", "exit 1"], options)
        : actual.spawn(file, args, options),
  };
});

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

const REPO_URL = "https://github.com/TEA-Core/paperclip";
const BRANCH = "SUP-24395-weekly-cycle";

let root: string;
let origin: string;
let seed: string;
let repoRoot: string;
let worktree: string;

interface Rows {
  executionWorkspace: Record<string, unknown>;
  projectWorkspace: Record<string, unknown>;
  workProducts: Array<Record<string, unknown>>;
  otherCards: string[];
}
let rows: Rows;

// Selects resolve by table. The recorded-merge-commit read selects only
// `metadata` and filters to merged pull_request rows in SQL; the zero-delta
// read selects every row's type, status and metadata.
const db = {
  select: (columns?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === executionWorkspaces) return Promise.resolve([rows.executionWorkspace]);
        if (table === projectWorkspaces) return Promise.resolve([rows.projectWorkspace]);
        if (table === issues) return Promise.resolve(rows.otherCards.map((identifier) => ({ identifier })));
        if (table === issueWorkProducts) {
          return Promise.resolve(
            columns && "type" in columns
              ? rows.workProducts
              : rows.workProducts.filter((row) => row.type === "pull_request" && row.status === "merged"),
          );
        }
        return Promise.resolve([]);
      },
    }),
  }),
} as unknown as Parameters<typeof evaluateDoneTierDeclaration>[0];

const CARD = {
  id: "issue-24395",
  companyId: "company-1",
  identifier: "SUP-24395",
  projectId: "project-1",
  projectWorkspaceId: "pw-1",
  executionWorkspaceId: "ew-1",
};

function card(deliveryRequirement: "repository_delivery" | "record_only" | null = "repository_delivery") {
  return { ...CARD, deliveryRequirement };
}

function originGit(...args: string[]): string {
  return git(origin, ...args);
}

function originResolves(ref: string): string | null {
  try {
    return originGit("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function answerGitHub(url: string): Response {
  const u = new URL(url);
  const repoPath = "/repos/TEA-Core/paperclip";
  if (u.pathname === repoPath) return json({ default_branch: "main" });
  const compare = new RegExp(`^${repoPath}/compare/([^/]+)\\.\\.\\.([^/]+)$`).exec(u.pathname);
  if (compare) {
    const base = originResolves(decodeURIComponent(compare[1]!));
    const head = originResolves(decodeURIComponent(compare[2]!));
    if (!base || !head) return json({ message: "Not Found" }, 404);
    return json({ ahead_by: Number.parseInt(originGit("rev-list", "--count", `${base}..${head}`), 10) });
  }
  const commit = new RegExp(`^${repoPath}/commits/([^/]+)$`).exec(u.pathname);
  if (commit) {
    if (plantDuringCommitsRead) writeFileSync(path.join(worktree, "during-network.txt"), "dirt\n");
    const sha = originResolves(decodeURIComponent(commit[1]!));
    return sha ? json({ sha }) : json({ message: "Not Found" }, 404);
  }
  const ref = new RegExp(`^${repoPath}/git/ref/heads/(.+)$`).exec(u.pathname);
  if (ref) {
    return originResolves(`refs/heads/${decodeURIComponent(ref[1]!)}`)
      ? json({ ref: `refs/heads/${decodeURIComponent(ref[1]!)}` })
      : json({ message: "Not Found" }, 404);
  }
  if (u.pathname === `${repoPath}/branches`) {
    const listed = originGit("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads");
    const branches = listed.length === 0 ? [] : listed.split("\n").map((line) => {
      const space = line.indexOf(" ");
      return { name: line.slice(0, space), commit: { sha: line.slice(space + 1) } };
    });
    return json(branches);
  }
  if (u.pathname === `${repoPath}/tags`) {
    const listed = originGit("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/tags");
    const tags = listed.length === 0 ? [] : listed.split("\n").map((line) => {
      const space = line.indexOf(" ");
      return { name: line.slice(0, space), commit: { sha: line.slice(space + 1) } };
    });
    return json(tags);
  }
  if (u.pathname === `${repoPath}/pulls`) {
    return json(pullRequestHeads.map((sha, index) => ({ number: index + 1, state: "open", head: { sha } })));
  }
  return json({ message: "Not Found" }, 404);
}

/** Advances origin/main past the card's HEAD, as a weekly cycle's base moves on. */
function advanceOriginMain() {
  writeFileSync(path.join(seed, "later.txt"), "later\n");
  git(seed, "add", "later.txt");
  git(seed, "commit", "-qm", "later work on main");
  git(seed, "push", "-q", origin, "main");
  git(repoRoot, "fetch", "-q", "origin");
}

function headSha(): string {
  return git(worktree, "rev-parse", "HEAD");
}

function declaration(head: string = headSha()) {
  return `Closed at Tier 2 (live): probe \`git -C . rev-list --count origin/main..HEAD\` head ${head} post-merge: origin/main..HEAD is 0 and the worktree is clean`;
}

// The status PATCH is the one door that re-checks a zero-delta measurement inside its write.
async function close(issue: Parameters<typeof evaluateDoneTierDeclaration>[1] = card(), comment = declaration()) {
  return evaluateDoneTierDeclaration(db, issue, comment, null, async () => [], null, null, { zeroDeltaRecheckedAtWrite: true });
}

const UNRECORDED =
  "Tier 2 declaration could not be verified: no recorded delivery merge commit is available " +
  "for this issue (merge_commit_unrecorded); the recorded merge commit is the full 40-hex " +
  "`mergeCommitSha` on the most recent merged pull_request work product, and there is no " +
  "fallback to the live branch tip. ";

let previousHome: string | undefined;

beforeEach(() => {
  resetZeroDeltaForgeCache();
  root = mkdtempSync(path.join(os.tmpdir(), "paperclip-zero-delta-"));
  previousHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = root;
  origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  seed = path.join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(path.join(seed, "a.txt"), "hello\n");
  writeFileSync(path.join(seed, ".gitignore"), "ignored.txt\nbuild/\n");
  git(seed, "add", "a.txt", ".gitignore");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", origin, "main");
  repoRoot = resolveManagedProjectWorkspaceDir({ companyId: "company-1", projectId: "project-1", repoName: "paperclip" });
  mkdirSync(path.dirname(repoRoot), { recursive: true });
  git(root, "clone", "-q", origin, repoRoot);
  worktree = path.join(repoRoot, ".paperclip", "worktrees", BRANCH);
  git(repoRoot, "worktree", "add", "-q", "-b", BRANCH, worktree, "origin/main");
  advanceOriginMain();

  rows = {
    executionWorkspace: {
      id: "ew-1",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "pw-1",
      sourceIssueId: "issue-24395",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      providerType: "git_worktree",
      providerRef: worktree,
      cwd: worktree,
      repoUrl: REPO_URL,
      baseRef: "origin/main",
      branchName: BRANCH,
    },
    projectWorkspace: { id: "pw-1", defaultRef: "main", repoRef: "main", repoUrl: REPO_URL },
    workProducts: [],
    otherCards: [],
  };
  mockGhFetch.mockReset();
  mockGhFetch.mockImplementation(async (url: string) => answerGitHub(String(url)));
  mockResolveLinkedPullRequestsWithState.mockReset();
  mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
  gitFault.onGit = null;
  plantDuringCommitsRead = false;
  pullRequestHeads.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousHome;
});

function expectZeroDeltaRefusal(result: DoneTierDeclarationResult, why: string) {
  expect(result.allowed).toBe(false);
  expect(result.tier).toBe(null);
  expect(result.reason.startsWith(UNRECORDED)).toBe(true);
  expect(result.reason).toContain(`A zero-delta close was not proven: ${why}`);
}

describe("zero-delta repository_delivery Tier 2 close (SUP-24402)", () => {
  it("accepts the SUP-24395 shape: no PR, no merge commit, 0 ahead, HEAD an ancestor of the base, clean worktree", async () => {
    const head = headSha();
    expect(git(worktree, "rev-list", "--count", "origin/main..HEAD")).toBe("0");
    expect(head).not.toBe(git(worktree, "rev-parse", "origin/main"));

    const result = await close();

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("tier2");
    expect(result.tier2Audit).toMatchObject({
      mergeCommit: null,
      probeHead: head,
      zeroDelta: {
        executionWorkspaceId: "ew-1",
        repository: "github.com/TEA-Core/paperclip",
        branch: BRANCH,
        baseBranch: "main",
        baseRef: "refs/remotes/origin/main",
        baseSha: git(worktree, "rev-parse", "origin/main"),
        headSha: head,
      },
    });
  });

  it("refuses a worktree with a commit the base lacks", async () => {
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 work");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has 1 commit(s) on HEAD that refs/remotes/origin/main lacks");
  });

  it("refuses a declaration of zero delta when the server measures commits ahead (the declaration is not evidence)", async () => {
    const declaredBase = git(worktree, "rev-parse", "origin/main");
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 work");
    expectZeroDeltaRefusal(
      await close(card(), declaration(declaredBase)),
      "the recorded worktree has 1 commit(s) on HEAD that refs/remotes/origin/main lacks",
    );
  });

  it("refuses a HEAD that diverged from the base", async () => {
    git(worktree, "reset", "-q", "--hard", "origin/main~1");
    writeFileSync(path.join(worktree, "side.txt"), "side\n");
    git(worktree, "add", "side.txt");
    git(worktree, "commit", "-qm", "SUP-24395 side");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has 1 commit(s) on HEAD that refs/remotes/origin/main lacks");
  });

  it("refuses a modified tracked file", async () => {
    writeFileSync(path.join(worktree, "a.txt"), "changed\n");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has uncommitted changes to tracked files");
  });

  it("refuses a staged change", async () => {
    writeFileSync(path.join(worktree, "a.txt"), "staged\n");
    git(worktree, "add", "a.txt");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has uncommitted changes to tracked files");
  });

  it("refuses an untracked file", async () => {
    writeFileSync(path.join(worktree, "notes.md"), "draft\n");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has untracked files");
  });

  it("refuses a tracked modification hidden from status by assume-unchanged", async () => {
    writeFileSync(path.join(worktree, "a.txt"), "hidden\n");
    git(worktree, "update-index", "--assume-unchanged", "a.txt");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has assume-unchanged index entries");
  });

  it("refuses untracked work hidden by an info/exclude rule the server did not write", async () => {
    writeFileSync(path.join(worktree, "hidden.md"), "draft\n");
    writeFileSync(path.join(repoRoot, ".git", "info", "exclude"), "hidden.md\n");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has info/exclude ignore rules the server did not write");
  });

  it("refuses a worktree that is not on the card's recorded branch", async () => {
    git(worktree, "checkout", "-q", "-b", "somebody-else", "origin/main");
    expectZeroDeltaRefusal(
      await close(),
      `the recorded worktree is on refs/heads/somebody-else, not on the card's recorded branch ${BRANCH}`,
    );
  });

  it.each(["open", "merged", "closed"])("refuses a card that links a pull request in state %s", async (state) => {
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      { displayName: "TEA-Core/paperclip#1300", cachedState: state, merged: state === "merged" },
    ]);
    expectZeroDeltaRefusal(await close(), `the card links pull requests (TEA-Core/paperclip#1300 ${state})`);
    expect(mockResolveLinkedPullRequestsWithState).toHaveBeenCalledWith(db, "company-1", "issue-24395", { includeDrafts: true });
  });

  it.each(["open", "merged", "closed"])("refuses a card that records a pull_request work product in status %s", async (status) => {
    rows.workProducts = [{ type: "pull_request", status, metadata: { prNumber: 1300 } }];
    expectZeroDeltaRefusal(await close(), `the card records a pull_request work product (status ${status})`);
  });

  it("refuses a card that records a merge commit outside a merged pull_request work product", async () => {
    rows.workProducts = [{ type: "artifact", status: "active", metadata: { mergeCommitSha: "c".repeat(40) } }];
    expectZeroDeltaRefusal(await close(), "the card records a merge commit on a work product");
  });

  it("keeps the merge-head comparison, not the zero-delta proof, when a merge commit is recorded", async () => {
    rows.workProducts = [
      { type: "pull_request", status: "merged", metadata: { mergeCommitSha: "c".repeat(40), mergedAt: "2026-11-01T00:00:00.000Z" } },
    ];
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(`does not match the delivery merge head ${"c".repeat(40)}`);
    expect(result.reason).not.toContain("zero-delta");
  });

  it("refuses when the base ref does not resolve in the worktree", async () => {
    rows.executionWorkspace.baseRef = "origin/release";
    rows.projectWorkspace.defaultRef = "release";
    expectZeroDeltaRefusal(
      await close(),
      "the base ref refs/remotes/origin/release does not resolve in the recorded worktree",
    );
  });

  it("refuses when the workspace records no base ref", async () => {
    rows.executionWorkspace.baseRef = null;
    expectZeroDeltaRefusal(await close(), "the card's execution workspace records no base ref");
  });

  it("refuses a base the agent pointed at its own branch instead of a project branch", async () => {
    git(worktree, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    rows.executionWorkspace.baseRef = `origin/${BRANCH}`;
    expectZeroDeltaRefusal(await close(), `the base ref origin/${BRANCH} is not one of the project's branches`);
  });

  it("refuses when git cannot read the recorded worktree", async () => {
    const comment = declaration();
    writeFileSync(path.join(worktree, ".git"), "gitdir: /nonexistent\n");
    expectZeroDeltaRefusal(await close(card(), comment), "the recorded worktree is not a Git work tree");
  });

  it("refuses when git answers that HEAD is not an ancestor although the count reads zero", async () => {
    gitFault.onGit = (args) => (args.includes("merge-base") ? "fail" : undefined);
    expectZeroDeltaRefusal(await close(), "the recorded worktree has a HEAD that is not an ancestor of refs/remotes/origin/main");
  });

  it("refuses a HEAD that moves while the worktree is being measured", async () => {
    const comment = declaration();
    gitFault.onGit = (args) => {
      if (!args.includes("status")) return;
      gitFault.onGit = null;
      git(worktree, "commit", "-q", "--allow-empty", "-m", "SUP-24395 racing commit");
    };
    expectZeroDeltaRefusal(await close(card(), comment), "the recorded worktree's HEAD moved while it was being measured");
  });

  it("refuses a recorded path inside the worktree rather than the worktree itself", async () => {
    mkdirSync(path.join(worktree, "sub"));
    rows.executionWorkspace.providerRef = path.join(worktree, "sub");
    expectZeroDeltaRefusal(await close(), "the recorded worktree is not a Git work tree");
  });

  it("refuses a worktree whose per-worktree core.worktree widens its top level beyond the recorded path", async () => {
    git(repoRoot, "config", "extensions.worktreeConfig", "true");
    git(worktree, "config", "--worktree", "core.worktree", path.dirname(worktree));
    expectZeroDeltaRefusal(await close(), "the recorded worktree has a work-tree top level other than its own path");
  });

  it("refuses when the recorded worktree path does not exist", async () => {
    rows.executionWorkspace.providerRef = path.join(root, "gone");
    expectZeroDeltaRefusal(await close(), "the recorded worktree path does not exist");
  });

  it("refuses when a read throws", async () => {
    mockResolveLinkedPullRequestsWithState.mockRejectedValue(new Error("db down"));
    expectZeroDeltaRefusal(await close(), "the proof could not be completed (db down)");
  });

  it("refuses when GitHub cannot compare a forge tip with the base", async () => {
    mockGhFetch.mockImplementation(async (url: string) =>
      String(url).includes("/compare/") ? json({ message: "boom" }, 502) : answerGitHub(String(url)));
    expectZeroDeltaRefusal(await close(), "the forge read failed (502)");
  });

  it("refuses a worktree whose local origin ref was moved onto its own commit (the remote is the authority)", async () => {
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 work");
    git(worktree, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    git(repoRoot, "update-ref", "refs/remotes/origin/main", headSha());
    expectZeroDeltaRefusal(await close(), `branch ${BRANCH} is not on the base line and is not a pull-request head`);
  });

  it("refuses when the card's branch on the remote carries commits the base lacks", async () => {
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 work");
    git(worktree, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    git(worktree, "reset", "-q", "--hard", "HEAD~1");
    expectZeroDeltaRefusal(await close(), `branch ${BRANCH} is not on the base line and is not a pull-request head`);
  });

  it("refuses a workspace the card does not own", async () => {
    rows.executionWorkspace.sourceIssueId = "issue-other";
    expectZeroDeltaRefusal(await close(), "the card's execution workspace is not one this card owns in this company");
  });

  it("refuses a workspace that is not the card's isolated git worktree", async () => {
    rows.executionWorkspace.mode = "shared_workspace";
    expectZeroDeltaRefusal(
      await close(),
      "the card's execution workspace is shared_workspace/git_worktree/git_worktree, not its own isolated git worktree",
    );
  });

  it("refuses a workspace whose repository is not the project's", async () => {
    rows.executionWorkspace.repoUrl = "https://github.com/someone/fork";
    expectZeroDeltaRefusal(await close(), "the card's delivery repository is not its project workspace's repository");
  });

  it("refuses when a forge tip compare fails", async () => {
    writeFileSync(path.join(seed, "ahead.txt"), "ahead\n");
    git(seed, "add", "ahead.txt");
    git(seed, "commit", "-qm", "ahead of base");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/other-work");
    mockGhFetch.mockImplementation(async (url: string) =>
      String(url).includes("/compare/") ? json({ message: "boom" }, 502) : answerGitHub(String(url)));
    expectZeroDeltaRefusal(await close(), "the forge read failed (502)");
  });

  it("refuses when a forge tip compare is not a compare result", async () => {
    writeFileSync(path.join(seed, "ahead.txt"), "ahead\n");
    git(seed, "add", "ahead.txt");
    git(seed, "commit", "-qm", "ahead of base");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/other-work");
    mockGhFetch.mockImplementation(async (url: string) =>
      String(url).includes("/compare/") ? json({ status: "identical" }) : answerGitHub(String(url)));
    expectZeroDeltaRefusal(await close(), "the forge could not compare");
  });

  it("refuses a worktree with a git operation in progress", async () => {
    writeFileSync(path.join(git(worktree, "rev-parse", "--absolute-git-dir"), "index.lock"), "");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has a Git operation in progress (index.lock is present)");
  });

  it("measures the recorded worktree, not a decoy a planted core.worktree points at", async () => {
    const comment = declaration();
    const decoy = path.join(root, "decoy");
    mkdirSync(decoy);
    writeFileSync(path.join(decoy, "a.txt"), "hello\n");
    writeFileSync(path.join(worktree, "a.txt"), "undelivered\n");
    git(worktree, "config", "core.worktree", decoy);
    const result = await close(card(), comment);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("A zero-delta close was not proven: the recorded worktree");
  });

  it("refuses a declaration whose probe head is not the HEAD the server measured", async () => {
    const result = await close(card(), declaration(git(worktree, "rev-parse", "origin/main")));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(`is not HEAD ${headSha()} of this card's own worktree`);
  });

  it("keeps today's refusal byte for byte on a record_only card, without measuring anything", async () => {
    const result = await close(card("record_only"));
    expect(result).toEqual({
      allowed: false,
      reason: `${UNRECORDED}Accepted form: ${TIER2_RECORD_ONLY_FORM} or ${TIER2_FORM}`,
      tier: null,
      skipped: false,
      skipReason: null,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
  });

  it.each([
    ["null", { ...CARD, deliveryRequirement: null }],
    ["absent", CARD],
  ])("keeps today's refusal byte for byte when the classification is %s", async (_label, issue) => {
    const result = await close(issue);
    expect(result).toEqual({
      allowed: false,
      reason: `${UNRECORDED}Accepted form: ${TIER2_FORM}`,
      tier: null,
      skipped: false,
      skipReason: null,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
  });
});

describe("zero-delta NO-GO regressions (RA 1213)", () => {
  it("refuses an ignored file the committed .gitignore hides from status", async () => {
    writeFileSync(path.join(worktree, "ignored.txt"), "undelivered\n");
    expect(git(worktree, "status", "--porcelain")).toBe("");
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("A zero-delta close was not proven: the recorded worktree has an ignored entry");
  });

  it("still accepts a regenerated-artefact directory a committed rule ignores", async () => {
    mkdirSync(path.join(worktree, "build"), { recursive: true });
    writeFileSync(path.join(worktree, "build", "output.txt"), "artefact\n");
    const result = await close();
    expect(result.allowed).toBe(true);
  });

  it("refuses a populated stash of the card's own repository", async () => {
    writeFileSync(path.join(worktree, "a.txt"), "parked\n");
    git(worktree, "stash", "push", "-q", "-m", "parked work");
    expect(git(worktree, "status", "--porcelain")).toBe("");
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("stash");
  });

  it("refuses a hidden local branch holding commits while HEAD sits at the base", async () => {
    git(worktree, "checkout", "-q", "-b", "SUP-24395-hidden");
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 hidden work");
    git(worktree, "checkout", "-q", BRANCH);
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SUP-24395-hidden");
  });

  it("refuses a local branch that belongs to no card", async () => {
    git(worktree, "checkout", "-q", "-b", "unrelated-work");
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "unrelated work");
    git(worktree, "checkout", "-q", BRANCH);
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("unrelated-work");
  });

  it("refuses a foreign remote branch naming this card that holds commits", async () => {
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 side work");
    git(worktree, "push", "-q", "origin", "HEAD:refs/heads/SUP-24395-side");
    git(worktree, "reset", "-q", "--hard", "HEAD~1");
    git(repoRoot, "fetch", "-q", "origin");
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SUP-24395-side");
  });

  it("refuses a second linked worktree of the same repository holding uncommitted work", async () => {
    const other = path.join(repoRoot, ".paperclip", "worktrees", "SUP-24395-other");
    git(repoRoot, "worktree", "add", "-q", "-b", "SUP-24395-other", other, "origin/main");
    writeFileSync(path.join(other, "draft.txt"), "undelivered\n");
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SUP-24395-other");
  });

  it("refuses a recorded path symlinked to a clean foreign repository", async () => {
    const foreign = path.join(root, "foreign");
    git(root, "clone", "-q", origin, foreign);
    git(foreign, "checkout", "-q", "-b", BRANCH, headSha());
    const link = path.join(root, "recorded-link");
    symlinkSync(foreign, link);
    rows.executionWorkspace.providerRef = link;
    rows.executionWorkspace.cwd = link;
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("the recorded worktree path is outside the project's managed worktree directory");
  });

  it("refuses an in-worktree .git file redirected to a foreign gitdir", async () => {
    const foreign = path.join(root, "foreign");
    git(root, "clone", "-q", origin, foreign);
    const foreignWorktree = path.join(foreign, "wt");
    git(foreign, "worktree", "add", "-q", "-b", BRANCH, foreignWorktree, headSha());
    git(foreign, "config", "core.worktree", worktree);
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(foreign, ".git", "worktrees", "wt")}\n`);
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("the recorded worktree is not a linked worktree of the managed checkout");
  });

  it("re-checks the measured worktree at the close write (dirt after measurement refuses)", async () => {
    const result = await close();
    expect(result.allowed).toBe(true);
    const measurement = (result as unknown as Record<string, unknown>).zeroDeltaMeasurement;
    expect(measurement).toBeDefined();
    const verify = (doneTransitionGuard as unknown as Record<string, unknown>).verifyZeroDeltaCloseAtTransition as
      | ((tx: unknown, locked: unknown, measurement: unknown) => Promise<{ ok: boolean; reason?: string }>)
      | undefined;
    expect(typeof verify).toBe("function");
    const locked = { ...CARD, deliveryRequirement: "repository_delivery" as const, status: "in_progress" };
    const clean = await verify!(db, locked, measurement);
    expect(clean.ok).toBe(true);
    writeFileSync(path.join(worktree, "late.txt"), "added after measurement\n");
    const dirty = await verify!(db, locked, measurement);
    expect(dirty.ok).toBe(false);
  });

  it("refuses at the close write when a pull request is linked after the measurement", async () => {
    const result = await close();
    expect(result.allowed).toBe(true);
    const measurement = (result as unknown as Record<string, unknown>).zeroDeltaMeasurement;
    const verify = (doneTransitionGuard as unknown as Record<string, unknown>).verifyZeroDeltaCloseAtTransition as
      (tx: unknown, locked: unknown, measurement: unknown) => Promise<{ ok: boolean; reason?: string }>;
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      { displayName: "TEA-Core/paperclip#1300", cachedState: "open", merged: false },
    ]);
    const verdict = await verify(db, { ...CARD, deliveryRequirement: "repository_delivery" as const, status: "in_progress" }, measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("pull request");
  });

  it("refuses at the close write when a pull_request work product appears after the measurement", async () => {
    const result = await close();
    expect(result.allowed).toBe(true);
    const measurement = (result as unknown as Record<string, unknown>).zeroDeltaMeasurement;
    const verify = (doneTransitionGuard as unknown as Record<string, unknown>).verifyZeroDeltaCloseAtTransition as
      (tx: unknown, locked: unknown, measurement: unknown) => Promise<{ ok: boolean; reason?: string }>;
    rows.workProducts = [{ type: "pull_request", status: "open", metadata: { prNumber: 1300 } }];
    const verdict = await verify(db, { ...CARD, deliveryRequirement: "repository_delivery" as const, status: "in_progress" }, measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("pull_request work product");
  });

  it("refuses a zero-delta declaration on the backstop close path", async () => {
    const verdict = await doneTransitionGuard.evaluateDoneTransitionGuardForBackstopClose({
      db,
      issue: card(),
      actorId: "system-sweep",
      closeComment: null,
      structuredDoneTier: {
        tier: "tier2",
        probeEvidence: `probe \`git -C . rev-list --count origin/main..HEAD\` head ${headSha()} post-merge: origin/main..HEAD is 0 and the worktree is clean`,
      },
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe("done_transition_missing_tier_declaration");
      expect(verdict.reason).toContain("accepted only on PATCH /api/issues/{id}");
    }
  });

  it("refuses a sibling commit hidden by moving the local base ref onto it", async () => {
    git(worktree, "checkout", "-q", "-b", "SUP-24395-hidden");
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 hidden work");
    const sibling = headSha();
    git(worktree, "checkout", "-q", BRANCH);
    git(worktree, "update-ref", "refs/remotes/origin/main", sibling);
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("A zero-delta close was not proven:");
  });

  it("refuses a second linked worktree with a detached HEAD holding uncommitted work", async () => {
    const other = path.join(repoRoot, ".paperclip", "worktrees", "detached-other");
    git(repoRoot, "worktree", "add", "-q", "--detach", other, "origin/main");
    writeFileSync(path.join(other, "draft.txt"), "undelivered\n");
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("detached");
  });

  it("refuses a shallow worktree (pin)", async () => {
    git(worktree, "fetch", "-q", "--depth=1", "origin");
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("shallow");
  });

  it("refuses a skip-worktree index entry (pin)", async () => {
    git(worktree, "update-index", "--skip-worktree", "a.txt");
    writeFileSync(path.join(worktree, "a.txt"), "hidden\n");
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("skip-worktree");
  });

  it("refuses a submodule index entry (pin)", async () => {
    git(worktree, "update-index", "--add", "--cacheinfo", `160000,${headSha()},submod`);
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("submodules");
  });

  it("refuses an unmerged index entry (pin)", async () => {
    const blob = git(worktree, "rev-parse", "HEAD:a.txt");
    execFileSync("git", ["-C", worktree, "update-index", "--index-info"], {
      env: fixtureEnv,
      input: `100644 ${blob} 1\tconflict.txt\n`,
    });
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("unmerged");
  });
});

describe("zero-delta review regressions (PR 1213 round 2)", () => {
  type Verify = (tx: unknown, locked: unknown, measurement: unknown) => Promise<{ ok: boolean; reason?: string }>;
  const verify = (measurement: unknown) =>
    (doneTransitionGuard.verifyZeroDeltaCloseAtTransition as unknown as Verify)(
      db,
      { ...CARD, deliveryRequirement: "repository_delivery" as const, status: "in_progress" },
      measurement,
    );
  async function measured() {
    const result = await close();
    expect(result.allowed, result.reason).toBe(true);
    const initial = await verify(result.zeroDeltaMeasurement);
    expect(initial.ok, initial.reason).toBe(true);
    return result.zeroDeltaMeasurement;
  }

  it("refuses a zero-delta declaration on a door that does not re-check it inside its status write", async () => {
    const result = await evaluateDoneTierDeclaration(db, card(), declaration(), null, async () => []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("merge_commit_unrecorded");
    expect(result.reason).toContain("PATCH /api/issues/{id}");
  });

  it("refuses when a forge tip compare omits the ahead count", async () => {
    writeFileSync(path.join(seed, "ahead.txt"), "ahead\n");
    git(seed, "add", "ahead.txt");
    git(seed, "commit", "-qm", "ahead of base");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/other-work");
    mockGhFetch.mockImplementation(async (url: string) =>
      String(url).includes("/compare/") ? json({ status: "identical" }) : answerGitHub(String(url)));
    expectZeroDeltaRefusal(await close(), "the forge could not compare");
  });

  it("refuses a base whose branch name itself starts with origin/ (the remote compare would strip it again)", async () => {
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "SUP-24395 work");
    git(worktree, "push", "-q", "origin", "HEAD:refs/heads/release");
    originGit("branch", "origin/release", "main");
    git(repoRoot, "update-ref", "refs/remotes/origin/origin/release", headSha());
    rows.executionWorkspace.baseRef = "origin/origin/release";
    rows.projectWorkspace.defaultRef = "origin/origin/release";
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("the base branch origin/release starts with origin/");
  });

  it("refuses at the close write when the recorded path now resolves to another directory", async () => {
    const link = path.join(root, "recorded-link");
    symlinkSync(worktree, link);
    rows.executionWorkspace.providerRef = link;
    rows.executionWorkspace.cwd = link;
    const measurement = await measured();
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, "work.txt"), "undelivered\n");
    rmSync(link);
    symlinkSync(elsewhere, link);
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("recorded worktree path");
  });

  it("refuses at the close write when the project setting that approved the base no longer does", async () => {
    originGit("branch", "release", "main");
    git(repoRoot, "fetch", "-q", "origin");
    rows.executionWorkspace.baseRef = "origin/release";
    rows.projectWorkspace.repoRef = "release";
    const measurement = await measured();
    rows.projectWorkspace.repoRef = "main";
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("the project's base branch settings changed after the close was measured");
  });

  it("refuses at the close write when a sibling worktree naming the card gains work after the measurement", async () => {
    const other = path.join(repoRoot, ".paperclip", "worktrees", "SUP-24395-other");
    git(repoRoot, "worktree", "add", "-q", "-b", "SUP-24395-other", other, headSha());
    const measurement = await measured();
    writeFileSync(path.join(other, "draft.txt"), "undelivered\n");
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("SUP-24395-other");
  });

  it("refuses at the close write when a branch naming the card appears after the measurement", async () => {
    const measurement = await measured();
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    const blob = git(worktree, "hash-object", "-w", "work.txt");
    rmSync(path.join(worktree, "work.txt"));
    const tree = execFileSync("git", ["-C", worktree, "mktree"], { env: fixtureEnv, input: `100644 blob ${blob}\twork.txt\n` })
      .toString().trim();
    const commit = git(worktree, "commit-tree", tree, "-p", headSha(), "-m", "SUP-24395 hidden work");
    git(repoRoot, "update-ref", "refs/heads/SUP-24395-late", commit);
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("branches");
  });

  it("refuses a stash ref that is not a commit (the stash state cannot be read as absent)", async () => {
    writeFileSync(path.join(worktree, "parked.txt"), "parked\n");
    const blob = git(worktree, "hash-object", "-w", "parked.txt");
    rmSync(path.join(worktree, "parked.txt"));
    git(worktree, "update-ref", "refs/stash", blob);
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("stash");
  });

  it("refuses at the close write a stash ref that is not a commit", async () => {
    const measurement = await measured();
    writeFileSync(path.join(worktree, "parked.txt"), "parked\n");
    const blob = git(worktree, "hash-object", "-w", "parked.txt");
    rmSync(path.join(worktree, "parked.txt"));
    git(worktree, "update-ref", "refs/stash", blob);
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("stash");
  });

  it("refuses with too_many_branch_tips when more than five distinct tips would need comparing", async () => {
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(path.join(seed, `tip-${index}.txt`), `${index}\n`);
      git(seed, "add", `tip-${index}.txt`);
      git(seed, "commit", "-qm", `tip ${index}`);
      git(seed, "push", "-q", origin, "main");
      git(repoRoot, "fetch", "-q", "origin");
      git(repoRoot, "branch", `SUP-24395-tip-${index}`, git(seed, "rev-parse", "HEAD"));
    }
    const result = await close();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("too_many_branch_tips");
  });
});

describe("zero-delta remote-base authority (RA 1213 still open)", () => {
  function plantUndelivered(): string {
    writeFileSync(path.join(worktree, "work.txt"), "undelivered-canary\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "undelivered");
    const planted = headSha();
    git(worktree, "reset", "--hard", "HEAD~1");
    return planted;
  }

  async function measured() {
    const result = await close();
    expect(result.allowed, result.reason).toBe(true);
    return result.zeroDeltaMeasurement!;
  }

  async function verify(measurement: unknown, locked: Record<string, unknown> = {}) {
    const verdict = await doneTransitionGuard.verifyZeroDeltaCloseAtTransition(
      db,
      { ...CARD, deliveryRequirement: "repository_delivery" as const, status: "in_progress", ...locked },
      measurement as never,
    );
    return verdict.ok ? { ok: true as const } : { ok: false as const, reason: verdict.reason };
  }

  it("refuses when the agent moves the local base ref onto undelivered work", async () => {
    const planted = plantUndelivered();
    git(repoRoot, "update-ref", "refs/remotes/origin/main", planted);
    expectZeroDeltaRefusal(await close(), "the local base ref refs/remotes/origin/main is not the remote base main");
  });

  it("refuses when packed-refs points the local base at undelivered work", async () => {
    const planted = plantUndelivered();
    git(repoRoot, "pack-refs", "--all");
    const packedPath = path.join(repoRoot, ".git", "packed-refs");
    const packed = readFileSync(packedPath, "utf8").replace(
      /^[0-9a-f]+ refs\/remotes\/origin\/main$/m,
      `${planted} refs/remotes/origin/main`,
    );
    writeFileSync(packedPath, packed);
    rmSync(path.join(repoRoot, ".git", "refs", "remotes", "origin", "main"), { force: true });
    expectZeroDeltaRefusal(await close(), "the local base ref refs/remotes/origin/main is not the remote base main");
  });

  it("refuses when the agent retargets origin and fetches a forged base", async () => {
    const planted = plantUndelivered();
    const attacker = path.join(root, "attacker.git");
    git(root, "init", "-q", "--bare", "-b", "main", attacker);
    git(worktree, "push", "-q", attacker, `${planted}:refs/heads/main`);
    git(repoRoot, "remote", "set-url", "origin", attacker);
    git(repoRoot, "fetch", "-q", "origin");
    expectZeroDeltaRefusal(await close(), "the local base ref refs/remotes/origin/main is not the remote base main");
  });

  it("refuses when an alternates file makes a forged base resolvable", async () => {
    const planted = plantUndelivered();
    const alt = path.join(root, "alt-objects");
    mkdirSync(alt, { recursive: true });
    writeFileSync(path.join(repoRoot, ".git", "objects", "info", "alternates"), `${alt}\n`);
    git(repoRoot, "update-ref", "refs/remotes/origin/main", planted);
    expectZeroDeltaRefusal(await close(), "the local base ref refs/remotes/origin/main is not the remote base main");
  });

  it("refuses at the close write when the local base ref is deleted", async () => {
    const measurement = await measured();
    git(repoRoot, "update-ref", "-d", "refs/remotes/origin/main");
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("local base ref");
  });

  it("refuses at the close write when the local base ref is moved onto undelivered work", async () => {
    const measurement = await measured();
    const planted = plantUndelivered();
    git(repoRoot, "update-ref", "refs/remotes/origin/main", planted);
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("local base ref");
  });

  it("refuses a broken loose refs/stash that hides a packed stash", async () => {
    writeFileSync(path.join(worktree, "a.txt"), "stashed-canary\n");
    git(worktree, "stash", "push", "-qm", "packed stash");
    git(repoRoot, "pack-refs", "--all");
    writeFileSync(path.join(repoRoot, ".git", "refs", "stash"), "not-a-sha\n");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has a stash that could not be read (refs/stash)");
  });

  it("refuses a fork remote tracking the recorded branch name with undelivered work", async () => {
    const planted = plantUndelivered();
    git(repoRoot, "update-ref", `refs/remotes/fork/${BRANCH}`, planted);
    expectZeroDeltaRefusal(await close(), `refs/remotes/fork/${BRANCH} holds a commit the remote base lacks`);
  });

  it("refuses a pre-existing forge branch that is not a pull-request head", async () => {
    writeFileSync(path.join(seed, "other.txt"), "undelivered\n");
    git(seed, "add", "other.txt");
    git(seed, "commit", "-qm", "other work");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/other-work");
    expectZeroDeltaRefusal(await close(), "branch other-work is not on the base line and is not a pull-request head");
  });

  it("admits a pre-existing forge branch whose tip is a pull-request head", async () => {
    writeFileSync(path.join(seed, "other.txt"), "undelivered\n");
    git(seed, "add", "other.txt");
    git(seed, "commit", "-qm", "other work");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/other-work");
    pullRequestHeads.push(git(seed, "rev-parse", "HEAD"));
    const result = await close();
    expect(result.allowed, result.reason).toBe(true);
  });

  it("refuses at the close write when a forge branch appears after the measurement", async () => {
    const measurement = await measured();
    writeFileSync(path.join(seed, "late.txt"), "undelivered\n");
    git(seed, "add", "late.txt");
    git(seed, "commit", "-qm", "late other work");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/other-work");
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("remote refs changed");
  });

  it("refuses at the close write when the remote base moves", async () => {
    const measurement = await measured();
    writeFileSync(path.join(seed, "base-moved.txt"), "later\n");
    git(seed, "add", "base-moved.txt");
    git(seed, "commit", "-qm", "base moved");
    git(seed, "push", "-q", origin, "main");
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("remote base commit changed");
  });

  it("refuses when the stash ref cannot be read", async () => {
    gitFault.onGit = (args) => (args.includes("for-each-ref") && args.includes("refs/stash") ? "fail" : undefined);
    expectZeroDeltaRefusal(await close(), "the recorded worktree has a stash that could not be read (refs/stash)");
  });

  it("refuses a broken loose ref that hides a packed ref", async () => {
    const planted = plantUndelivered();
    git(repoRoot, "update-ref", "refs/hidden/work", planted);
    git(repoRoot, "pack-refs", "--all");
    mkdirSync(path.join(repoRoot, ".git", "refs", "hidden"), { recursive: true });
    writeFileSync(path.join(repoRoot, ".git", "refs", "hidden", "work"), "not-a-sha\n");
    expectZeroDeltaRefusal(await close(), "the recorded worktree could not be measured (a local ref could not be read (refs/hidden/work))");
  });

  it("refuses a packed ref shadowed by a loose ref at the remote base", async () => {
    const planted = plantUndelivered();
    const base = git(repoRoot, "rev-parse", "refs/remotes/origin/main");
    git(repoRoot, "update-ref", "refs/hidden/work", planted);
    git(repoRoot, "pack-refs", "--all");
    mkdirSync(path.join(repoRoot, ".git", "refs", "hidden"), { recursive: true });
    writeFileSync(path.join(repoRoot, ".git", "refs", "hidden", "work"), `${base}\n`);
    expectZeroDeltaRefusal(await close(), "refs/hidden/work holds a commit the remote base lacks");
  });

  it("refuses a commit that exists only in the reflog", async () => {
    plantUndelivered();
    expectZeroDeltaRefusal(await close(), "logs/refs/heads/SUP-24395-weekly-cycle holds a commit the remote base lacks");
  });

  it("refuses dirt planted during the close-write remote read", async () => {
    const measurement = await measured();
    plantDuringCommitsRead = true;
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("uncommitted changes");
  });

  it("refuses undelivered work parked on the local project branch", async () => {
    const planted = plantUndelivered();
    git(repoRoot, "update-ref", "refs/heads/main", planted);
    expectZeroDeltaRefusal(await close(), "refs/heads/main holds a commit the remote base lacks");
  });

  it("refuses undelivered work parked on a hidden ref", async () => {
    const planted = plantUndelivered();
    git(repoRoot, "update-ref", "refs/hidden/work", planted);
    expectZeroDeltaRefusal(await close(), "refs/hidden/work holds a commit the remote base lacks");
  });

  it("refuses undelivered work parked on another card's rescue branch", async () => {
    const planted = plantUndelivered();
    rows.otherCards = ["SUP-9999"];
    git(repoRoot, "update-ref", "refs/heads/paperclip/rescue/SUP-9999/1", planted);
    expectZeroDeltaRefusal(await close(), "refs/heads/paperclip/rescue/SUP-9999/1 holds a commit the remote base lacks");
  });

  it("refuses at the close write when the card's remote branch gains a commit", async () => {
    const measurement = await measured();
    writeFileSync(path.join(seed, "later-branch.txt"), "ahead\n");
    git(seed, "add", "later-branch.txt");
    git(seed, "commit", "-qm", "ahead of main");
    git(seed, "push", "-q", origin, `HEAD:refs/heads/${BRANCH}`);
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("remote refs changed");
  });

  it("refuses at the close write when the issue's project workspace changed", async () => {
    const measurement = await measured();
    const verdict = await verify(measurement, { projectWorkspaceId: "pw-other" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("project workspace");
  });

  it("refuses a CRLF copy of the server exclude line at measurement", async () => {
    writeFileSync(path.join(repoRoot, ".git", "info", "exclude"), "/.paperclip-repositories/\r\n");
    expectZeroDeltaRefusal(await close(), "the recorded worktree has info/exclude ignore rules the server did not write");
  });

  it("refuses when no GitHub credential is configured", async () => {
    vi.mocked(resolveGitHubToken).mockResolvedValueOnce({ token: "", scope: "company", secretName: "GITHUB_TOKEN" });
    expectZeroDeltaRefusal(await close(), "no GitHub credential is configured");
  });

  it("refuses at the close write when the issue is already done", async () => {
    const measurement = await measured();
    const verdict = await verify(measurement, { status: "done" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("status changed");
  });

  it("refuses at the close write when the delivery requirement changed", async () => {
    const measurement = await measured();
    const verdict = await verify(measurement, { deliveryRequirement: "record_only" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("repository_delivery");
  });

  it("refuses at the close write when a merge-commit work product appears", async () => {
    const measurement = await measured();
    rows.workProducts = [{ type: "note", status: "done", metadata: { mergeCommitSha: "a".repeat(40) } }];
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("merge commit");
  });

  it("refuses at the close write when the execution workspace is no longer this card's", async () => {
    const measurement = await measured();
    rows.executionWorkspace = { ...rows.executionWorkspace, sourceIssueId: "other-issue" };
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("execution workspace");
  });

  it("refuses at the close write when the project repository URL changed", async () => {
    const measurement = await measured();
    rows.projectWorkspace = { ...rows.projectWorkspace, repoUrl: "https://github.com/TEA-Core/other" };
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("repository");
  });

  it("refuses at the close write when the project defaultRef changed", async () => {
    const measurement = await measured();
    rows.projectWorkspace = { ...rows.projectWorkspace, defaultRef: "release" };
    const verdict = await verify(measurement);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("base branch settings");
  });
});

describe("zeroDeltaWorktreeRefusal (SUP-24402)", () => {
  const base = "refs/remotes/origin/main";
  const clean = { aheadCountOutput: "0\n", headIsAncestorOfBase: true, statusRecords: [] };

  it("accepts exactly zero ahead, an ancestor HEAD and an empty status", () => {
    expect(zeroDeltaWorktreeRefusal(clean, base)).toBe(null);
  });

  it.each(["", "abc", "-1", "0 1"])("refuses an unreadable commit count %j", (aheadCountOutput) => {
    expect(zeroDeltaWorktreeRefusal({ ...clean, aheadCountOutput }, base)).toBe(`printed no commit count for ${base}..HEAD`);
  });

  it("refuses a nonzero commit count", () => {
    expect(zeroDeltaWorktreeRefusal({ ...clean, aheadCountOutput: "2\n" }, base)).toBe(`has 2 commit(s) on HEAD that ${base} lacks`);
  });

  it("refuses a HEAD that is not an ancestor even when the count reads zero", () => {
    expect(zeroDeltaWorktreeRefusal({ ...clean, headIsAncestorOfBase: false }, base)).toBe(
      `has a HEAD that is not an ancestor of ${base}`,
    );
  });

  it.each([[" M a.txt"], ["M  a.txt"], ["R  b.txt", "a.txt"]])("refuses tracked status records %j", (...statusRecords) => {
    expect(zeroDeltaWorktreeRefusal({ ...clean, statusRecords }, base)).toBe("has uncommitted changes to tracked files");
  });

  it("refuses untracked status records", () => {
    expect(zeroDeltaWorktreeRefusal({ ...clean, statusRecords: ["?? notes.md"] }, base)).toBe("has untracked files");
  });
});
