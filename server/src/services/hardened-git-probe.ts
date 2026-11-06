import { spawn } from "node:child_process";
import { constants as fsConstants, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
// Every close-gating invocation here therefore:
//   - runs a root-owned Git binary from a fixed system path, never a PATH lookup;
//   - runs with an environment built from scratch: no inherited `GIT_*`
//     variable, no system or global configuration, a fixed PATH;
//   - forces `core.fsmonitor`, `core.hooksPath`, the untracked cache, the
//     global excludes and attributes files and the commit graph off through
//     command-line configuration, which outranks repository configuration
//     no matter when the repository writes it;
//   - allows no transport and no lazy fetch, so a promisor remote written into
//     the repository's configuration cannot make a missing object run
//     `core.sshCommand`, `remote.*.uploadpack` or any other transport helper;
//   - is killed after a timeout, together with every process it started (it
//     leads its own process group, and the whole group is killed).
// The pre-existing fail-open probes opt out of the from-scratch environment
// (`inheritEnvironment`) so the server's safe.directory and global
// configuration keep applying; they lose only the three redirecting variables,
// and, as before, carry no timeout.
// The record_only no-repository probe additionally never computes a worktree
// status against the repository's own git dir: it runs against a private
// snapshot git dir (a copy of the index, the HEAD commit, the shared object
// store as an alternate, and a server-written config), so no repository-local
// configuration — and therefore no filter driver, whatever its name or however
// late it is written — is read by the process that reads worktree content.

const TRUSTED_GIT_BINARY_PATHS = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"] as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_COMPARED_TIPS = 5;
const MAX_EXCLUDE_FILE_BYTES = 1024 * 1024;
const MAX_INDEX_FILE_BYTES = 256 * 1024 * 1024;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The two overrides that stop repository-local configuration from running a
// program; every invocation carries them.
const EXECUTION_GUARD_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
];

// Command-line configuration applied to every hardened invocation
// (GIT_CONFIG_COUNT entries are command-line scope, so they win over repository
// config).
const FORCED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ...EXECUTION_GUARD_CONFIG,
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
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_COUNT: String(FORCED_CONFIG.length),
  };
  FORCED_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (ceilingDirectory) env.GIT_CEILING_DIRECTORIES = ceilingDirectory;
  return env;
}

function inheritedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

export interface HardenedGitOptions {
  /** Process working directory: a control-plane directory, never a probed workspace. */
  cwd: string;
  timeoutMs?: number;
  /** Stops repository discovery above this directory. */
  ceilingDirectory?: string | null;
  /**
   * For the pre-existing fail-open probes only. Keeps the server's own
   * environment and git configuration (global and system config, `GIT_CONFIG_*`
   * `safe.directory` entries, PATH), minus the `GIT_DIR`, `GIT_WORK_TREE` and
   * `GIT_INDEX_FILE` variables that redirect which repository is read; forces
   * fsmonitor and hooks off on the command line; runs `git` from PATH when no
   * trusted binary exists; and applies no timeout unless `timeoutMs` is given. A
   * probe that gates a close must leave this unset.
   */
  inheritEnvironment?: boolean;
  /** Written to the process's standard input. */
  input?: string;
}

/** How the pre-existing repository_delivery probes run git (done-transition-guard.ts `runGit`). */
export const LEGACY_WORKTREE_GIT_OPTIONS: Readonly<HardenedGitOptions> = { cwd: "/", inheritEnvironment: true };

/**
 * Run `file` and resolve its standard output. With a timeout the process leads
 * its own process group, and the timeout kills the whole group, so a program it
 * started (a helper, or a shell's background job) cannot outlive it.
 */
export function runBoundedProcess(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const killGroup = options.timeoutMs > 0;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: killGroup,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(killGroup ? -child.pid : child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const finish = (error: HardenedGitError | null, stdout = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    if (killGroup) {
      timer = setTimeout(() => {
        kill();
        finish(new HardenedGitError("timeout", "git timed out"));
      }, options.timeoutMs);
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        kill();
        finish(new HardenedGitError("failed", "git output exceeded the buffer"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(new HardenedGitError("failed", "git failed")));
    child.on("close", (code) => {
      if (code === 0) finish(null, Buffer.concat(chunks).toString("utf8"));
      else finish(new HardenedGitError("failed", "git failed"));
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input);
  });
}

/** Run one Git command under the hardened environment; resolves stdout. */
export function runHardenedGit(args: readonly string[], options: HardenedGitOptions): Promise<string> {
  const inherit = options.inheritEnvironment === true;
  const trustedGit = resolveTrustedGitBinary();
  if (!trustedGit && !inherit) {
    return Promise.reject(new HardenedGitError("unavailable", "no root-owned git binary at a fixed system path"));
  }
  const guardArgs = inherit ? EXECUTION_GUARD_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]) : [];
  return runBoundedProcess(trustedGit ?? "git", [...guardArgs, "--no-optional-locks", ...args], {
    cwd: options.cwd,
    env: inherit ? inheritedGitEnv() : hardenedGitEnv(options.ceilingDirectory ?? null),
    timeoutMs: options.timeoutMs ?? (inherit ? 0 : DEFAULT_TIMEOUT_MS),
    input: options.input,
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

/**
 * Reads a file inside the agent-writable repository. It is opened without
 * following a symlink and without blocking on a FIFO, must be a regular file no
 * larger than `maxBytes`, and is read through the handle, so a swapped-in FIFO,
 * `/dev/zero` link or oversize file fails instead of hanging a thread or
 * exhausting memory. Throws on anything else.
 */
async function readRegularFile(target: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new HardenedGitError("failed", "not a regular file within the size limit");
    }
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > stat.size) throw new HardenedGitError("failed", "file grew while it was read");
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

async function readOptionalRegularFile(target: string, maxBytes: number): Promise<string | null> {
  try {
    return (await readRegularFile(target, maxBytes)).toString("utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

const MAX_REF_FILE_BYTES = 4096;
const MAX_PACKED_REFS_BYTES = 64 * 1024 * 1024;

/**
 * The branch and commit a linked worktree's HEAD names, read from the ref files
 * without running Git: `<gitDir>/HEAD`, then the loose ref or `packed-refs` in
 * the common dir. Null when HEAD is not a branch or a file is not a plain,
 * bounded file (a reftable repository included). The no-repository close
 * compares this with its measured head while it holds the issue row, where no
 * Git process may run.
 */
export async function readWorktreeHeadFromFiles(
  gitDir: string,
  commonDir: string,
): Promise<{ branch: string; sha: string } | null> {
  try {
    const head = (await readRegularFile(path.join(gitDir, "HEAD"), MAX_REF_FILE_BYTES)).toString("utf8").trim();
    const match = /^ref: refs\/heads\/(\S+)$/.exec(head);
    if (!match) return null;
    const branch = match[1]!;
    const components = branch.split("/");
    if (components.some((component) => component.length === 0 || component === "." || component === "..")) return null;
    const loose = await readOptionalRegularFile(path.join(commonDir, "refs", "heads", ...components), MAX_REF_FILE_BYTES);
    if (loose !== null) {
      const sha = loose.trim();
      return SHA_RE.test(sha) ? { branch, sha } : null;
    }
    const packed = await readOptionalRegularFile(path.join(commonDir, "packed-refs"), MAX_PACKED_REFS_BYTES);
    if (packed === null) return null;
    const refName = `refs/heads/${branch}`;
    for (const line of packed.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0 && line.slice(space + 1) === refName && SHA_RE.test(line.slice(0, space))) {
        return { branch, sha: line.slice(0, space) };
      }
    }
    return null;
  } catch {
    return null;
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
        await writeFile(
          path.join(snapshot, name),
          await readRegularFile(path.join(input.identity.gitDir, name), MAX_INDEX_FILE_BYTES),
        );
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

/**
 * Ignored directories a record_only close does not count as dirt: regenerated
 * artefacts (dependency trees, build output, caches) and the directories
 * Paperclip itself creates in a worktree (`.paperclip` from the worktree
 * provision script, `.paperclip-runtime` from adapters and the heartbeat,
 * `.paperclip-repositories` from project-repository provisioning). A name
 * matches at any depth, but only as an ordinary directory with no symlink on
 * the path to it. Files inside a listed directory are not inspected; every
 * other ignored entry is dirt.
 */
export const IGNORED_ARTIFACT_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "target",
  PROJECT_REPOSITORIES_DIR,
  ".paperclip",
  ".paperclip-runtime",
]);

async function isIgnoredArtifactDirectory(workTree: string, entry: string): Promise<boolean> {
  // `ls-files --directory` names a wholly ignored directory once, with a
  // trailing slash; a file or a symlink is listed without one.
  if (!entry.endsWith("/")) return false;
  const components = entry.slice(0, -1).split("/");
  if (!IGNORED_ARTIFACT_DIRECTORY_NAMES.has(components[components.length - 1]!)) return false;
  let current = workTree;
  for (const component of components) {
    if (component.length === 0 || component === "." || component === "..") return false;
    current = path.join(current, component);
    try {
      if (!(await lstat(current)).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The first ignored entry that is not an allowlisted artefact directory; null when there is none. */
async function firstDisallowedIgnoredEntry(
  snapshotGitDir: string,
  workTree: string,
  options: HardenedGitOptions,
): Promise<string | null> {
  const entries = (await runHardenedGit(
    [
      "-C", workTree, `--git-dir=${snapshotGitDir}`, `--work-tree=${workTree}`,
      "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory",
    ],
    options,
  )).split("\0").filter((record) => record.length > 0);
  for (const entry of entries) {
    if (!(await isIgnoredArtifactDirectory(workTree, entry))) return entry;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a branch name carries this issue identifier as its own token. */
export function branchNamesIssue(branch: string, identifier: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(identifier)}(?![0-9])`, "i").test(branch);
}

/**
 * Card identifiers `text` names other than `identifier`, upper-cased: any
 * upper-case `PREFIX-<n>` token, plus this card's own prefix in any case. Each
 * token stands on its own (no letter or digit before it, no digit after it),
 * so for SUP-7, `SUP-70` and `XSUP-7` are other cards and `SUP-7-notes` is not.
 */
export function otherCardIdentifiers(text: string, identifier: string): string[] {
  const own = identifier.toUpperCase();
  const ownPrefix = own.replace(/-\d+$/, "");
  const found = new Set<string>();
  const patterns = [
    /(?<![A-Za-z0-9])[A-Z][A-Z0-9]*-\d+(?![0-9])/g,
    new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(ownPrefix)}-\\d+(?![0-9])`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0].toUpperCase();
      if (token !== own) found.add(token);
    }
  }
  return [...found];
}

/** Project default branch, reduced to a branch name; null when it is not one. */
export function normalizeBaseBranch(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  let name = ref.trim();
  if (name.startsWith("origin/")) name = name.slice("origin/".length);
  if (
    name.length === 0 ||
    name === "HEAD" ||
    name.startsWith("refs/") ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/")
  ) {
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
  | {
      ok: true;
      branch: string;
      headSha: string;
      /** The recorded worktree after symlink resolution, its git dir and the managed checkout's common dir. */
      worktreePath: string;
      gitDir: string;
      commonDir: string;
      /** Every tip compared with the default branch on the remote, the recorded worktree's first. */
      comparedTips: string[];
    }
  | { ok: false; reason: string };

function refuse(reason: string): NoRepositoryWorktreeProbeResult {
  return { ok: false, reason };
}

type CleanWorktreeVerdict =
  | { ok: true; branch: string; headSha: string; gitDir: string }
  | { ok: false; reason: string };

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
  let exclude: string | null;
  try {
    exclude = await readOptionalRegularFile(path.join(identity.commonDir, "info", "exclude"), MAX_EXCLUDE_FILE_BYTES);
  } catch {
    return { ok: false, reason: "status could not be verified" };
  }
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
          if (entry.stage !== "0") return "has unmerged index entries";
          if (entry.tag === "S") return "has skip-worktree index entries";
          if (entry.tag !== "H") return "has assume-unchanged index entries";
          if (entry.mode === "160000") return "has submodules";
        }
        if (await snapshotStatusIsDirty(snapshot, worktreePath, "all", worktreeOptions)) {
          return "has uncommitted changes (modified, staged or untracked)";
        }
        const ignored = await firstDisallowedIgnoredEntry(snapshot, worktreePath, worktreeOptions);
        return ignored === null
          ? null
          : `has an ignored entry outside the regenerated-artefact directories (${JSON.stringify(ignored.slice(0, 200))})`;
      },
    );
    if (dirtyReason) return { ok: false, reason: dirtyReason };
  } catch {
    return { ok: false, reason: "status could not be verified" };
  }
  return { ok: true, branch: branchRef.slice("refs/heads/".length), headSha, gitDir: identity.gitDir };
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
 * write — and a tip it cannot measure refuses. The branch-name and worktree
 * scans below read refs an agent can write, so they are advisory; the remote
 * comparison of the recorded worktree's tip is the authority. Every Git process
 * runs from the managed checkout as its working directory.
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
  if (!branchNamesIssue(own.branch, input.issueIdentifier)) {
    return refuse(`the recorded worktree's branch does not name ${input.issueIdentifier}`);
  }
  const otherCards = otherCardIdentifiers(own.branch, input.issueIdentifier);
  if (otherCards.length > 0) {
    return refuse(`the recorded worktree's branch ${own.branch} also names another card (${otherCards.join(", ")})`);
  }

  try {
    const checkedTips = new Set<string>([own.headSha]);
    const ownRefusal = await aheadOfBaseRefusal("the recorded worktree", own.headSha, input.countCommitsAheadOfBase);
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
      if (checkedTips.size >= MAX_COMPARED_TIPS) {
        return refuse(
          `too_many_branch_tips: the recorded worktree and the branches naming this issue have more than ${MAX_COMPARED_TIPS} distinct tips to compare with the default branch`,
        );
      }
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
    return {
      ok: true,
      branch: own.branch,
      headSha: own.headSha,
      worktreePath: candidate,
      gitDir: own.gitDir,
      commonDir,
      comparedTips: [...checkedTips],
    };
  } catch {
    return refuse("the managed checkout's branches could not be verified");
  }
}
