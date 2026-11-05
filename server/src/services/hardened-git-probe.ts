import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";

// SUP-22880 / SUP-22570: the one Git runner for probes that read a workspace an
// agent can write.
//
// A workspace's repository is agent-writable: its config, hooks, attributes,
// `.git` file, index and refs. Git honours repository-local configuration from
// a directory owned by the invoking uid, and Paperclip's managed checkouts are
// owned by the server uid whether or not the agent-uid split is armed (the
// entrypoint normalises worktrees to the server uid and shares them through the
// `agents` group). So a plain `git -C <workspace> status` run by the server
// executes whatever the repository names as `core.fsmonitor`, a `filter.*`
// driver, or an `include.path` target that sets either, and follows
// `core.worktree` or an inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`
// to a different tree than the one it was asked about.
//
// Every invocation here therefore:
//   - runs a root-owned Git binary from a fixed system path, never a PATH lookup;
//   - runs with an environment built from scratch: no inherited `GIT_*`
//     variable, no system or global configuration, a fixed PATH;
//   - forces `core.fsmonitor`, `core.hooksPath`, the untracked cache, the
//     global excludes and attributes files and the commit graph off through
//     command-line configuration, which outranks repository configuration
//     no matter when the repository writes it;
//   - is killed after a timeout.
// The record_only no-repository probe additionally never computes a worktree
// status against the repository's own git dir: it runs against a private
// snapshot git dir (a copy of the index, the HEAD commit, the shared object
// store as an alternate, and a server-written config), so no repository-local
// configuration — and therefore no filter driver, whatever its name or however
// late it is written — is read by the process that reads worktree content.

const TRUSTED_GIT_BINARY_PATHS = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"] as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Command-line configuration applied to every invocation (GIT_CONFIG_COUNT
// entries are command-line scope, so they win over repository config).
const FORCED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.untrackedCache", "false"],
  ["core.excludesFile", "/dev/null"],
  ["core.attributesFile", "/dev/null"],
  ["core.commitGraph", "false"],
];

// The only info/exclude rule the server writes into a task workspace
// (heartbeat prepareProjectRepositoryWorkspaces).
const SERVER_WRITTEN_EXCLUDE_LINE = `/${PROJECT_REPOSITORIES_DIR}/`;

export class HardenedGitError extends Error {
  constructor(
    readonly kind: "unavailable" | "failed" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "HardenedGitError";
  }
}

let trustedGitBinary: string | null | undefined;

function isRootOwnedAndNotWritableByOthers(target: string): boolean {
  const stat = statSync(target);
  return stat.uid === 0 && (stat.mode & 0o022) === 0;
}

/**
 * The absolute Git binary every probe runs. Only a root-owned executable in a
 * root-owned system directory qualifies, so neither the server uid nor an
 * agent sharing it can replace the binary the server executes.
 */
export function resolveTrustedGitBinary(): string | null {
  if (trustedGitBinary !== undefined) return trustedGitBinary;
  trustedGitBinary = null;
  for (const candidate of TRUSTED_GIT_BINARY_PATHS) {
    try {
      const stat = statSync(candidate);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      if (!isRootOwnedAndNotWritableByOthers(candidate)) continue;
      if (!isRootOwnedAndNotWritableByOthers(path.dirname(candidate))) continue;
      trustedGitBinary = candidate;
      break;
    } catch {
      // Not present on this host; try the next fixed location.
    }
  }
  return trustedGitBinary;
}

function hardenedGitEnv(ceilingDirectory: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_CONFIG_COUNT: String(FORCED_CONFIG.length),
  };
  FORCED_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (ceilingDirectory) env.GIT_CEILING_DIRECTORIES = ceilingDirectory;
  return env;
}

export interface HardenedGitOptions {
  /** Process working directory: a control-plane directory, never a probed workspace. */
  cwd: string;
  timeoutMs?: number;
  /** Stops repository discovery above this directory. */
  ceilingDirectory?: string | null;
  /**
   * When no trusted git binary exists, run `git` from PATH (still under the
   * stripped environment) instead of failing. Only for probes that predate the
   * trusted-binary requirement and fail open on an unmeasured result; a probe
   * that gates a close must leave this unset and refuse.
   */
  pathFallback?: boolean;
}

/** Run one Git command under the hardened environment; resolves stdout. */
export function runHardenedGit(args: readonly string[], options: HardenedGitOptions): Promise<string> {
  const trustedGit = resolveTrustedGitBinary();
  if (!trustedGit && !options.pathFallback) {
    return Promise.reject(new HardenedGitError("unavailable", "no root-owned git binary at a fixed system path"));
  }
  const git = trustedGit ?? "git";
  const env = hardenedGitEnv(options.ceilingDirectory ?? null);
  if (!trustedGit && process.env.PATH) env.PATH = process.env.PATH;
  return new Promise((resolve, reject) => {
    execFile(
      git,
      ["--no-optional-locks", ...args],
      {
        cwd: options.cwd,
        env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          const timedOut = "killed" in error && error.killed === true;
          reject(new HardenedGitError(timedOut ? "timeout" : "failed", timedOut ? "git timed out" : "git failed"));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function snapshotConfig(objectFormat: "sha1" | "sha256"): string {
  const lines = [
    "[core]",
    `\trepositoryformatversion = ${objectFormat === "sha256" ? 1 : 0}`,
    "\tbare = false",
  ];
  if (objectFormat === "sha256") lines.push("[extensions]", "\tobjectformat = sha256");
  return `${lines.join("\n")}\n`;
}

interface WorktreeIdentity {
  gitDir: string;
  commonDir: string;
  topLevel: string;
  objectFormat: "sha1" | "sha256";
}

async function readWorktreeIdentity(worktreePath: string, options: HardenedGitOptions): Promise<WorktreeIdentity> {
  const out = await runHardenedGit(
    [
      "-C", worktreePath,
      "rev-parse", "--path-format=absolute",
      "--git-dir", "--git-common-dir", "--show-toplevel", "--show-object-format",
    ],
    options,
  );
  const lines = out.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 4) throw new HardenedGitError("failed", "unparseable git identity");
  const objectFormat = lines[3];
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new HardenedGitError("failed", "unknown object format");
  }
  return {
    gitDir: await realpath(lines[0]!),
    commonDir: await realpath(lines[1]!),
    topLevel: await realpath(lines[2]!),
    objectFormat,
  };
}

async function readHeadCommit(worktreePath: string, options: HardenedGitOptions): Promise<string | null> {
  try {
    const sha = (await runHardenedGit(["-C", worktreePath, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options)).trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function readOptionalFile(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Run `fn` against a private git dir that shares the worktree's object store
 * (read-only, as an alternate) and a copy of its index, but whose config,
 * HEAD and info/exclude the server wrote. Git reading worktree content through
 * it never reads the repository's own configuration.
 */
async function withSnapshotGitDir<T>(
  input: {
    identity: WorktreeIdentity;
    headSha: string | null;
    config: string;
    exclude: string | null;
  },
  fn: (snapshotGitDir: string) => Promise<T>,
): Promise<T> {
  const snapshot = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-probe-"));
  try {
    await mkdir(path.join(snapshot, "objects", "info"), { recursive: true });
    await mkdir(path.join(snapshot, "refs", "heads"), { recursive: true });
    await mkdir(path.join(snapshot, "info"), { recursive: true });
    await writeFile(path.join(snapshot, "objects", "info", "alternates"), `${path.join(input.identity.commonDir, "objects")}\n`);
    await writeFile(
      path.join(snapshot, "HEAD"),
      input.headSha ? `${input.headSha}\n` : "ref: refs/heads/paperclip-probe-unborn\n",
    );
    await writeFile(path.join(snapshot, "config"), input.config);
    if (input.exclude !== null) await writeFile(path.join(snapshot, "info", "exclude"), input.exclude);
    for (const name of await readdir(input.identity.gitDir)) {
      if (name === "index" || name.startsWith("sharedindex.")) {
        await copyFile(path.join(input.identity.gitDir, name), path.join(snapshot, name));
      }
    }
    return await fn(snapshot);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

interface IndexEntry {
  tag: string;
  mode: string;
  stage: string;
  path: string;
}

async function listIndexEntries(
  snapshotGitDir: string,
  workTree: string,
  options: HardenedGitOptions,
): Promise<IndexEntry[]> {
  const raw = await runHardenedGit(
    ["-C", workTree, `--git-dir=${snapshotGitDir}`, `--work-tree=${workTree}`, "ls-files", "-z", "-v", "-s"],
    options,
  );
  const entries: IndexEntry[] = [];
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const match = /^(\S) (\d{6}) [0-9a-f]+ (\d)\t(.*)$/s.exec(record);
    if (!match) throw new HardenedGitError("failed", "unparseable index listing");
    entries.push({ tag: match[1]!, mode: match[2]!, stage: match[3]!, path: match[4]! });
  }
  return entries;
}

async function snapshotStatusIsDirty(
  snapshotGitDir: string,
  workTree: string,
  ignoreSubmodules: "all" | "dirty",
  options: HardenedGitOptions,
): Promise<boolean> {
  const raw = await runHardenedGit(
    [
      "-C", workTree, `--git-dir=${snapshotGitDir}`, `--work-tree=${workTree}`,
      "status", "--porcelain=v1", "-z", "--untracked-files=all", `--ignore-submodules=${ignoreSubmodules}`,
    ],
    options,
  );
  return raw.split("\0").some((record) => record.length > 0);
}

/** Whether a branch name carries this issue identifier as its own token. */
export function branchNamesIssue(branch: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, "i").test(branch);
}

/** Project default branch, reduced to a branch name; null when it is not one. */
export function normalizeBaseBranch(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  let name = ref.trim();
  for (const prefix of ["refs/remotes/origin/", "refs/heads/", "origin/"]) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  if (name.length === 0 || name === "HEAD" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    return null;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes("..") || name.includes("//") || name.endsWith(".lock")) {
    return null;
  }
  return name;
}

export interface NoRepositoryWorktreeProbeInput {
  /** Path recorded on the execution workspace row. A candidate only: it must land in the managed layout. */
  recordedWorktreePath: string;
  /** `<instanceRoot>/projects/<companyId>/<projectId>`, derived from server env and immutable ids. */
  managedProjectRoot: string;
  issueIdentifier: string;
  /**
   * Commits `sha` carries beyond the project's default branch, measured on the
   * remote (a source the agent cannot write). Throws when it cannot be
   * measured — for example when the commit is not on the remote at all.
   */
  countCommitsAheadOfBase: (sha: string) => Promise<number>;
  timeoutMs?: number;
}

export type NoRepositoryWorktreeProbeResult =
  | { ok: true; branch: string; headSha: string }
  | { ok: false; reason: string };

function refuse(reason: string): NoRepositoryWorktreeProbeResult {
  return { ok: false, reason };
}

interface CleanWorktreeVerdict {
  ok: boolean;
  reason?: string;
  branch?: string;
  headSha?: string;
}

/**
 * Identity, configuration, index and status checks for one linked worktree of
 * the managed checkout. Shared by the recorded worktree and any other
 * worktree checked out on a branch that names the issue.
 */
async function verifyCleanLinkedWorktree(
  worktreePath: string,
  expectedCommonDir: string,
  options: HardenedGitOptions,
): Promise<CleanWorktreeVerdict> {
  const worktreeOptions: HardenedGitOptions = { ...options, ceilingDirectory: path.dirname(worktreePath) };
  let flags: string[];
  try {
    flags = (await runHardenedGit(
      [
        "-C", worktreePath, "rev-parse",
        "--is-bare-repository", "--is-inside-git-dir", "--is-inside-work-tree", "--is-shallow-repository",
      ],
      worktreeOptions,
    )).split("\n").filter((line) => line.length > 0);
  } catch {
    return { ok: false, reason: "is not a Git work tree" };
  }
  if (flags.length !== 4) return { ok: false, reason: "could not be identified as a Git work tree" };
  if (flags[0] !== "false") return { ok: false, reason: "is a bare repository" };
  if (flags[1] !== "false") return { ok: false, reason: "is inside a Git directory" };
  if (flags[2] !== "true") return { ok: false, reason: "is not a Git work tree" };
  if (flags[3] !== "false") return { ok: false, reason: "is a shallow clone" };

  let identity: WorktreeIdentity;
  try {
    identity = await readWorktreeIdentity(worktreePath, worktreeOptions);
  } catch {
    return { ok: false, reason: "could not be identified as a Git work tree" };
  }
  if (identity.topLevel !== worktreePath) {
    return { ok: false, reason: "has a work-tree top level other than its own path" };
  }
  if (identity.commonDir !== expectedCommonDir || path.dirname(identity.gitDir) !== path.join(expectedCommonDir, "worktrees")) {
    return { ok: false, reason: "is not a linked worktree of the managed checkout" };
  }
  const headSha = await readHeadCommit(worktreePath, worktreeOptions);
  if (!headSha) return { ok: false, reason: "has no HEAD commit" };
  let branchRef: string;
  try {
    branchRef = (await runHardenedGit(["-C", worktreePath, "symbolic-ref", "--quiet", "HEAD"], worktreeOptions)).trim();
  } catch {
    return { ok: false, reason: "has a detached HEAD" };
  }
  if (!branchRef.startsWith("refs/heads/")) return { ok: false, reason: "has a detached HEAD" };
  if (await lstat(path.join(identity.gitDir, "index.lock")).then(() => true, () => false)) {
    return { ok: false, reason: "has a Git operation in progress (index.lock is present)" };
  }
  const exclude = await readOptionalFile(path.join(identity.commonDir, "info", "exclude"));
  if (
    exclude !== null &&
    exclude.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#") && trimmed !== SERVER_WRITTEN_EXCLUDE_LINE;
    })
  ) {
    return { ok: false, reason: "has info/exclude ignore rules the server did not write" };
  }
  try {
    const dirtyReason = await withSnapshotGitDir(
      { identity, headSha, config: snapshotConfig(identity.objectFormat), exclude },
      async (snapshot) => {
        for (const entry of await listIndexEntries(snapshot, worktreePath, worktreeOptions)) {
          if (entry.tag === "S") return "has skip-worktree index entries";
          if (entry.tag !== "H") return "has assume-unchanged index entries";
          if (entry.mode === "160000") return "has submodules";
          if (entry.stage !== "0") return "has unmerged index entries";
        }
        return (await snapshotStatusIsDirty(snapshot, worktreePath, "all", worktreeOptions))
          ? "has uncommitted changes (modified, staged or untracked)"
          : null;
      },
    );
    if (dirtyReason) return { ok: false, reason: dirtyReason };
  } catch {
    return { ok: false, reason: "status could not be verified" };
  }
  return { ok: true, branch: branchRef.slice("refs/heads/".length), headSha };
}

/** Why `sha` may not stand as "level with the default branch"; null when it does. */
async function aheadOfBaseRefusal(
  subject: string,
  sha: string,
  countCommitsAheadOfBase: NoRepositoryWorktreeProbeInput["countCommitsAheadOfBase"],
): Promise<string | null> {
  let ahead: number;
  try {
    ahead = await countCommitsAheadOfBase(sha);
    if (!Number.isInteger(ahead) || ahead < 0) throw new Error("not a commit count");
  } catch {
    return `${subject} tip ${sha.slice(0, 12)} could not be compared with the project's default branch on the remote`;
  }
  return ahead === 0 ? null : `${subject} has ${ahead} commit(s) not on the project's default branch`;
}

/**
 * SUP-22570: prove that the issue's own managed git worktree carries no
 * repository deliverable — clean, zero commits ahead of the project's default
 * branch — and that no other branch or worktree naming the issue in the managed
 * checkout carries one either.
 *
 * The recorded workspace path is only a candidate: it must resolve (symlinks
 * included) into `<managedProjectRoot>/<repo>/.paperclip/worktrees/…`, the
 * layout the server derives from the company and project ids, and be a linked
 * worktree of that managed checkout. "Ahead of the default branch" is measured
 * by the caller-supplied `countCommitsAheadOfBase` against the remote — never
 * against a ref in the managed checkout, whose refs every agent worktree can
 * write — and a tip it cannot measure refuses. Every Git process runs from the
 * managed checkout as its working directory.
 */
export async function probeNoRepositoryWorktree(
  input: NoRepositoryWorktreeProbeInput,
): Promise<NoRepositoryWorktreeProbeResult> {
  if (!resolveTrustedGitBinary()) return refuse("no root-owned git binary is installed at a fixed system path");

  let managedRoot: string;
  let candidate: string;
  try {
    managedRoot = await realpath(input.managedProjectRoot);
  } catch {
    return refuse("the project's managed checkout directory does not exist");
  }
  try {
    candidate = await realpath(input.recordedWorktreePath);
  } catch {
    return refuse("the recorded worktree path does not exist");
  }
  const relative = path.relative(managedRoot, candidate);
  const segments = relative.split(path.sep);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    segments.length < 4 ||
    segments.some((segment) => segment.length === 0 || segment === "..") ||
    segments[1] !== ".paperclip" ||
    segments[2] !== "worktrees"
  ) {
    return refuse("the recorded worktree path is outside the project's managed worktree directory");
  }
  const repoRoot = path.join(managedRoot, segments[0]!);
  let commonDir: string;
  try {
    const gitDirStat = await lstat(path.join(repoRoot, ".git"));
    if (!gitDirStat.isDirectory()) return refuse("the managed checkout has no .git directory");
    commonDir = await realpath(path.join(repoRoot, ".git"));
  } catch {
    return refuse("the managed checkout has no .git directory");
  }
  const options: HardenedGitOptions = { cwd: repoRoot, timeoutMs: input.timeoutMs, ceilingDirectory: managedRoot };

  const own = await verifyCleanLinkedWorktree(candidate, commonDir, options);
  if (!own.ok) return refuse(`the recorded worktree ${own.reason}`);
  if (!branchNamesIssue(own.branch!, input.issueIdentifier)) {
    return refuse(`the recorded worktree's branch does not name ${input.issueIdentifier}`);
  }

  try {
    const checkedTips = new Set<string>([own.headSha!]);
    const ownRefusal = await aheadOfBaseRefusal("the recorded worktree", own.headSha!, input.countCommitsAheadOfBase);
    if (ownRefusal) return refuse(ownRefusal);

    const branches = (await runHardenedGit(
      ["-C", repoRoot, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"],
      options,
    )).split("\n").filter((line) => line.length > 0);
    for (const line of branches) {
      const space = line.indexOf(" ");
      const sha = line.slice(0, space);
      const name = line.slice(space + 1).slice("refs/heads/".length);
      if (!SHA_RE.test(sha) || !branchNamesIssue(name, input.issueIdentifier) || checkedTips.has(sha)) continue;
      checkedTips.add(sha);
      const refusal = await aheadOfBaseRefusal(`branch ${name}`, sha, input.countCommitsAheadOfBase);
      if (refusal) return refuse(refusal);
    }

    const worktreeRecords = (await runHardenedGit(["-C", repoRoot, "worktree", "list", "--porcelain", "-z"], options))
      .split("\0\0")
      .map((record) => record.split("\0").filter((field) => field.length > 0))
      .filter((fields) => fields.length > 0);
    for (const fields of worktreeRecords) {
      const worktreeField = fields.find((field) => field.startsWith("worktree "));
      const branchField = fields.find((field) => field.startsWith("branch refs/heads/"));
      if (!worktreeField || !branchField) continue;
      const branch = branchField.slice("branch refs/heads/".length);
      if (!branchNamesIssue(branch, input.issueIdentifier)) continue;
      let worktreePath: string;
      try {
        worktreePath = await realpath(worktreeField.slice("worktree ".length));
      } catch {
        continue; // prunable: the directory is gone, so it holds no uncommitted content
      }
      if (worktreePath === candidate) continue;
      const other = await verifyCleanLinkedWorktree(worktreePath, commonDir, options);
      if (!other.ok) return refuse(`another worktree on branch ${branch} ${other.reason}`);
    }
    return { ok: true, branch: own.branch!, headSha: own.headSha! };
  } catch {
    return refuse("the managed checkout's branches could not be verified");
  }
}
