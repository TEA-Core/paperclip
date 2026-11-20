import { spawn } from "node:child_process";
import { constants as fsConstants, createWriteStream, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { type FileHandle, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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

/**
 * One wall-clock budget shared by every Git process and file copy of a
 * check: each step gets only the time left, and `expired` records that the
 * budget ran out (rather than a step failing for another reason).
 */
export interface ProbeDeadline {
  at: number;
  expired: boolean;
}

function remainingBudget(deadline: ProbeDeadline): number {
  const remaining = deadline.at - Date.now();
  if (remaining <= 0) {
    deadline.expired = true;
    throw new HardenedGitError("timeout", "the shared deadline passed");
  }
  return remaining;
}

export interface HardenedGitOptions {
  /** Process working directory: a control-plane directory, never a probed workspace. */
  cwd: string;
  timeoutMs?: number;
  /** Replaces `timeoutMs`: the process gets the time left on this shared budget. */
  deadline?: ProbeDeadline;
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
  /** Exit codes other than 0 that still mean success (`check-ignore` exits 1 when nothing matched). */
  successExitCodes?: readonly number[];
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
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string; successExitCodes?: readonly number[] },
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
      if (code === 0 || (code !== null && options.successExitCodes?.includes(code))) {
        finish(null, Buffer.concat(chunks).toString("utf8"));
      } else {
        finish(new HardenedGitError("failed", "git failed"));
      }
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
  const { deadline } = options;
  let timeoutMs = options.timeoutMs ?? (inherit ? 0 : DEFAULT_TIMEOUT_MS);
  if (deadline) {
    try {
      timeoutMs = remainingBudget(deadline);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const run = runBoundedProcess(trustedGit ?? "git", [...guardArgs, "--no-optional-locks", ...args], {
    cwd: options.cwd,
    env: inherit ? inheritedGitEnv() : hardenedGitEnv(options.ceilingDirectory ?? null),
    timeoutMs,
    input: options.input,
    successExitCodes: options.successExitCodes,
  });
  if (!deadline) return run;
  return run.catch((error: unknown) => {
    if (error instanceof HardenedGitError && error.kind === "timeout") deadline.expired = true;
    throw error;
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
 * Opens a file inside the agent-writable repository without following a symlink
 * and without blocking on a FIFO, and hands `fn` the handle only if it is a
 * regular file no larger than `maxBytes`, so a swapped-in FIFO, `/dev/zero`
 * link or oversize file fails instead of hanging a thread or exhausting memory.
 * Throws on anything else.
 */
async function withRegularFile<T>(
  target: string,
  maxBytes: number,
  fn: (handle: FileHandle, size: number) => Promise<T>,
): Promise<T> {
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new HardenedGitError("failed", "not a regular file within the size limit");
    }
    return await fn(handle, stat.size);
  } finally {
    await handle.close();
  }
}

/** Buffers a small file whole: only for files whose limit is a few kilobytes. */
async function readRegularFile(target: string, maxBytes: number): Promise<Buffer> {
  return withRegularFile(target, maxBytes, async (handle, size) => {
    const buffer = Buffer.allocUnsafe(size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > size) throw new HardenedGitError("failed", "file grew while it was read");
    return buffer.subarray(0, filled);
  });
}

/**
 * Streams a bounded regular file to `destination` through the validated handle,
 * never holding it in memory, and returns the bytes copied so the caller can
 * charge them against a shared budget.
 */
async function copyRegularFile(
  source: string,
  destination: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  return withRegularFile(source, maxBytes, async (handle, size) => {
    if (size === 0) {
      await writeFile(destination, "");
      return 0;
    }
    await pipeline(
      handle.createReadStream({ start: 0, end: size - 1, autoClose: false }),
      createWriteStream(destination),
      { signal },
    );
    if ((await handle.stat()).size !== size) throw new HardenedGitError("failed", "file changed while it was copied");
    return size;
  });
}

async function readOptionalRegularFile(target: string, maxBytes: number): Promise<string | null> {
  try {
    return (await readRegularFile(target, maxBytes)).toString("utf8");
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
    deadline?: ProbeDeadline;
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
    let indexBudget = MAX_INDEX_FILE_BYTES;
    for (const name of await readdir(input.identity.gitDir)) {
      if (name === "index" || name.startsWith("sharedindex.")) {
        const signal = input.deadline ? AbortSignal.timeout(remainingBudget(input.deadline)) : undefined;
        try {
          indexBudget -= await copyRegularFile(
            path.join(input.identity.gitDir, name),
            path.join(snapshot, name),
            indexBudget,
            signal,
          );
        } catch (error) {
          if (input.deadline && signal?.aborted) input.deadline.expired = true;
          throw error;
        }
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

/** `status --porcelain=v1 -z --untracked-files=all` through the snapshot git dir, one entry per NUL-separated record. */
async function snapshotStatusRecords(
  snapshotGitDir: string,
  workTree: string,
  ignoreSubmodules: "all" | "dirty",
  options: HardenedGitOptions,
): Promise<string[]> {
  const raw = await runHardenedGit(
    [
      "-C", workTree, `--git-dir=${snapshotGitDir}`, `--work-tree=${workTree}`,
      "status", "--porcelain=v1", "-z", "--untracked-files=all", `--ignore-submodules=${ignoreSubmodules}`,
    ],
    options,
  );
  return raw.split("\0").filter((record) => record.length > 0);
}

/**
 * Ignored directories a record_only close does not count as dirt: regenerated
 * artefacts (dependency trees, build output, caches) and the directories
 * Paperclip itself creates in a worktree (`.paperclip` from the worktree
 * provision script, `.paperclip-runtime` from adapters and the heartbeat,
 * `.paperclip-repositories` from project-repository provisioning). A name
 * matches at any depth, but only as an ordinary directory with no symlink on
 * the path to it, and only when a rule the repository commits (or the line the
 * server writes to `info/exclude`) ignores it: an untracked or modified ignore
 * file cannot make a listed name ignored. Files inside a listed directory are
 * not inspected; every other ignored entry is dirt.
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

/**
 * The first ignored entry that refuses, with whether its name is on the
 * allowlist (then no committed rule ignores it); null when there is none.
 * `trackedPaths` are the paths the index holds; the status check has already
 * shown each unmodified.
 */
async function firstDisallowedIgnoredEntry(
  snapshotGitDir: string,
  workTree: string,
  trackedPaths: ReadonlySet<string>,
  options: HardenedGitOptions,
): Promise<{ entry: string; listed: boolean } | null> {
  const gitArgs = ["-C", workTree, `--git-dir=${snapshotGitDir}`, `--work-tree=${workTree}`];
  const entries = (await runHardenedGit(
    [...gitArgs, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
    options,
  )).split("\0").filter((record) => record.length > 0);
  const listed: string[] = [];
  for (const entry of entries) {
    if (!(await isIgnoredArtifactDirectory(workTree, entry))) return { entry, listed: false };
    listed.push(entry);
  }
  if (listed.length === 0) return null;
  // Which rule ignores each listed directory itself (named without the trailing
  // slash, so a `.gitignore` inside it does not count): `source NUL line NUL
  // pattern NUL path NUL`, with an empty source for a path no rule ignores.
  const verdicts = (await runHardenedGit(
    [...gitArgs, "check-ignore", "-v", "-n", "-z", "--stdin"],
    { ...options, input: `${listed.map((entry) => entry.slice(0, -1)).join("\0")}\0`, successExitCodes: [1] },
  )).split("\0");
  const serverExclude = path.join(snapshotGitDir, "info", "exclude");
  const committed = new Set<string>();
  for (let index = 0; index + 3 < verdicts.length; index += 4) {
    const [source, , pattern, directory] = verdicts.slice(index, index + 4) as [string, string, string, string];
    const committedSource =
      source === serverExclude || (path.posix.basename(source) === ".gitignore" && trackedPaths.has(source));
    if (committedSource && !pattern.startsWith("!")) committed.add(`${directory}/`);
  }
  const uncommitted = listed.find((entry) => !committed.has(entry));
  return uncommitted === undefined ? null : { entry: uncommitted, listed: true };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a branch name carries this issue identifier as its own token. */
export function branchNamesIssue(branch: string, identifier: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(identifier)}(?![0-9])`, "i").test(branch);
}

// Standard names written like card identifiers (ISO-8601, SHA-256, UTF-8, RFC-9110 …).
const NON_CARD_IDENTIFIER_PREFIXES: ReadonlySet<string> = new Set([
  "CVE", "CWE", "ECMA", "HTTP", "IEC", "IEEE", "ISO", "RFC", "SHA", "TLS", "UTF",
]);

/**
 * Upper-cased tokens of `text` matching `patterns` other than `identifier`.
 * Each token stands on its own (no letter or digit before it, no digit after
 * it), so for SUP-7, `SUP-70` and `XSUP-7` are other cards and `SUP-7-notes` is
 * not. A standard name (`ISO-8601`) is not a card, except under this card's own
 * prefix: for card ISO-7, `ISO-9` is another card.
 */
function otherCardTokens(text: string, identifier: string, patterns: readonly RegExp[]): string[] {
  const own = identifier.toUpperCase();
  const ownPrefix = own.replace(/-\d+$/, "");
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0].toUpperCase();
      const prefix = token.replace(/-\d+$/, "");
      if (token !== own && (prefix === ownPrefix || !NON_CARD_IDENTIFIER_PREFIXES.has(prefix))) found.add(token);
    }
  }
  return [...found];
}

/**
 * Card identifiers a declaration names other than `identifier`: every
 * `<word>-<number>` token in any case, so `other-999`, `SUP-70` and `phase-2`
 * all refuse the declaration (fail closed).
 */
export function otherCardIdentifiers(text: string, identifier: string): string[] {
  return otherCardTokens(text, identifier, [/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*-\d+(?![0-9])/g]);
}

/**
 * Card identifiers the recorded worktree's branch names other than
 * `identifier`: any upper-case `PREFIX-<n>` token, plus this card's own prefix
 * in any case. A default-template branch is the lower-cased issue title after
 * the identifier, so `phase-2`, `sprint-12` or `q3-2026` in it name no card;
 * a lower-case foreign card's branch is refused by the attribution rule.
 */
function otherCardIdentifiersInBranch(branch: string, identifier: string): string[] {
  const ownPrefix = identifier.toUpperCase().replace(/-\d+$/, "");
  return otherCardTokens(branch, identifier, [
    /(?<![A-Za-z0-9])[A-Z][A-Z0-9]*-\d+(?![0-9])/g,
    new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(ownPrefix)}-\\d+(?![0-9])`, "gi"),
  ]);
}

/** The card a rescue branch (`paperclip/rescue/<ISSUE-ID>/<timestamp>`) names; null for any other branch. */
function rescueBranchOwner(branch: string): string | null {
  return /^paperclip\/rescue\/([^/]+)\/.+$/.exec(branch)?.[1] ?? null;
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
  permittedOtherCardIdentifiers?: ReadonlySet<string>;
  /**
   * The project's own branches (its default and reference branches and the
   * repository's default branch on the remote): their local branches carry no
   * card's work.
   */
  projectBranches: ReadonlySet<string>;
  /**
   * Branch names registered to ANOTHER issue's execution workspace in this
   * company and project (a board-only field): those branches are that card's.
   */
  attributedBranches: ReadonlySet<string>;
  /**
   * Which of `candidates` are the identifier of an existing issue of this
   * company other than this card. Asked once, with the second path segments of
   * the rescue branches the server keeps (`paperclip/rescue/<ISSUE-ID>/<time>`):
   * such a branch is attributed to that card.
   */
  existingOtherCardIdentifiers: (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
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
      /** The recorded worktree after symlink resolution and the managed checkout's common dir. */
      worktreePath: string;
      commonDir: string;
      /** Every tip compared with the default branch on the remote, the recorded worktree's first. */
      comparedTips: string[];
    }
  | { ok: false; reason: string };

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

type CleanWorktreeVerdict =
  | { ok: true; branch: string; headSha: string }
  | { ok: false; reason: string };

/** Why the path is not a plain, full-history Git work tree; null when it is one. */
async function worktreeShapeRefusal(worktreePath: string, options: HardenedGitOptions): Promise<string | null> {
  let flags: string[];
  try {
    flags = (await runHardenedGit(
      [
        "-C", worktreePath, "rev-parse",
        "--is-bare-repository", "--is-inside-git-dir", "--is-inside-work-tree", "--is-shallow-repository",
      ],
      options,
    )).split("\n").filter((line) => line.length > 0);
  } catch {
    return "is not a Git work tree";
  }
  if (flags.length !== 4) return "could not be identified as a Git work tree";
  if (flags[0] !== "false") return "is a bare repository";
  if (flags[1] !== "false") return "is inside a Git directory";
  if (flags[2] !== "true") return "is not a Git work tree";
  if (flags[3] !== "false") return "is a shallow clone";
  return null;
}

/** Info/exclude rules other than the one the server writes: they can hide untracked work from status. */
function hasForeignExcludeRules(exclude: string | null): boolean {
  return (
    exclude !== null &&
    exclude.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#") && trimmed !== SERVER_WRITTEN_EXCLUDE_LINE;
    })
  );
}

/** Why an index entry hides or blocks a status check; null for a plain stage-0 tracked file. */
function indexEntryRefusal(entry: IndexEntry): string | null {
  if (entry.stage !== "0") return "has unmerged index entries";
  if (entry.tag === "S") return "has skip-worktree index entries";
  if (entry.tag !== "H") return "has assume-unchanged index entries";
  if (entry.mode === "160000") return "has submodules";
  return null;
}

/**
 * Why the repository's stash is not provably empty; null only when
 * `refs/stash` is confirmed absent. Any object there (not only a commit)
 * refuses, and so does a failed read.
 */
async function stashRefusal(worktreePath: string, options: HardenedGitOptions): Promise<string | null> {
  let stash: string;
  try {
    stash = (await runHardenedGit(["-C", worktreePath, "for-each-ref", "--format=%(objectname)", "refs/stash"], options)).trim();
  } catch {
    return "has a stash that could not be read (refs/stash)";
  }
  return stash.length > 0 ? "has a stash of uncommitted work (refs/stash)" : null;
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
  const shapeRefusal = await worktreeShapeRefusal(worktreePath, worktreeOptions);
  if (shapeRefusal) return { ok: false, reason: shapeRefusal };

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
  const stash = await stashRefusal(worktreePath, worktreeOptions);
  if (stash) return { ok: false, reason: stash };
  let exclude: string | null;
  try {
    exclude = await readOptionalRegularFile(path.join(identity.commonDir, "info", "exclude"), MAX_EXCLUDE_FILE_BYTES);
  } catch {
    return { ok: false, reason: "status could not be verified" };
  }
  if (hasForeignExcludeRules(exclude)) {
    return { ok: false, reason: "has info/exclude ignore rules the server did not write" };
  }
  try {
    const dirtyReason = await withSnapshotGitDir(
      { identity, headSha, config: snapshotConfig(identity.objectFormat), exclude, deadline: worktreeOptions.deadline },
      async (snapshot) => {
        const trackedPaths = new Set<string>();
        for (const entry of await listIndexEntries(snapshot, worktreePath, worktreeOptions)) {
          const entryRefusal = indexEntryRefusal(entry);
          if (entryRefusal) return entryRefusal;
          trackedPaths.add(entry.path);
        }
        if ((await snapshotStatusRecords(snapshot, worktreePath, "all", worktreeOptions)).length > 0) {
          return "has uncommitted changes (modified, staged or untracked)";
        }
        const ignored = await firstDisallowedIgnoredEntry(snapshot, worktreePath, trackedPaths, worktreeOptions);
        if (ignored === null) return null;
        const entry = JSON.stringify(ignored.entry.slice(0, 200));
        return ignored.listed
          ? `has a regenerated-artefact directory that no committed ignore rule ignores (${entry})`
          : `has an ignored entry outside the regenerated-artefact directories (${entry})`;
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
 * branch — that no other branch or worktree naming the issue in the managed
 * checkout carries one either, and that every other local branch belongs to a
 * card: one of the project's branches, a branch registered to another issue's
 * execution workspace, or the rescue branch of another existing card of the
 * company. Any other branch refuses, whatever its tip, so another card's name
 * cannot carry this card's work.
 *
 * The recorded workspace path is only a candidate: it must resolve (symlinks
 * included) into `<managedProjectRoot>/<repo>/.paperclip/worktrees/…`, the
 * layout the server derives from the company and project ids, and be a linked
 * worktree of that managed checkout. "Ahead of the default branch" is measured
 * by the caller-supplied `countCommitsAheadOfBase` against the remote — never
 * against a ref in the managed checkout, whose refs every agent worktree can
 * write — and a tip it cannot measure refuses. The branch and worktree scans
 * below read refs an agent can write, so they are advisory; the remote
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
  const otherCards = otherCardIdentifiersInBranch(own.branch, input.issueIdentifier)
    .filter((identifier) => !input.permittedOtherCardIdentifiers?.has(identifier));
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
    )).split("\n").filter((line) => line.length > 0).map((line) => {
      const space = line.indexOf(" ");
      return { sha: line.slice(0, space), name: line.slice(space + 1).slice("refs/heads/".length) };
    });
    const rescueOwners = [...new Set(branches.flatMap(({ name }) => {
      const owner = branchNamesIssue(name, input.issueIdentifier) ? null : rescueBranchOwner(name);
      return owner === null ? [] : [owner];
    }))];
    const rescuedCards = rescueOwners.length > 0 ? await input.existingOtherCardIdentifiers(rescueOwners) : new Set<string>();
    for (const { sha, name } of branches) {
      if (!SHA_RE.test(sha)) continue;
      if (!branchNamesIssue(name, input.issueIdentifier)) {
        const rescueOwner = rescueBranchOwner(name);
        if (
          input.projectBranches.has(name) ||
          input.attributedBranches.has(name) ||
          (rescueOwner !== null && rescuedCards.has(rescueOwner))
        ) {
          continue;
        }
        return refuse(
          `branch ${name} belongs to no card: it is not this card's, not one of the project's branches, not registered to another card's workspace, and not another card's rescue branch`,
        );
      }
      if (checkedTips.has(sha)) continue;
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

    const final = await verifyCleanLinkedWorktree(candidate, commonDir, options);
    if (!final.ok) return refuse(`the recorded worktree ${final.reason}`);
    if (final.branch !== own.branch || final.headSha !== own.headSha) {
      return refuse(
        `the recorded worktree moved from ${own.branch} at ${own.headSha.slice(0, 12)} to ${final.branch} at ${final.headSha.slice(0, 12)} while it was being verified`,
      );
    }
    return {
      ok: true,
      branch: own.branch,
      headSha: own.headSha,
      worktreePath: candidate,
      commonDir,
      comparedTips: [...checkedTips],
    };
  } catch {
    return refuse("the managed checkout's branches could not be verified");
  }
}

const IN_TRANSACTION_RECHECK_BUDGET_MS = 15_000;

/**
 * The status write's re-check, inside its transaction: the measured worktree
 * must still be clean (index, status, ignored entries) on the measured branch
 * and commit. With `siblings` (the zero-delta close), the branches the sibling
 * scan read must also be unchanged and every other worktree on a branch naming
 * the card still clean. No GitHub call, and one shared 15 s budget for every
 * Git process and the snapshot copy bounds how long it can hold the issue row;
 * the budget running out refuses with a distinct "timed out" reason, never
 * "status could not be verified".
 */
export async function recheckRecordedWorktree(input: {
  worktreePath: string;
  commonDir: string;
  branch: string;
  headSha: string;
  siblings?: { issueIdentifier: string; refsDigest: string };
  budgetMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!resolveTrustedGitBinary()) return { ok: false, reason: "no root-owned git binary is installed at a fixed system path" };
  const budgetMs = input.budgetMs ?? IN_TRANSACTION_RECHECK_BUDGET_MS;
  const deadline: ProbeDeadline = { at: Date.now() + budgetMs, expired: false };
  const repoRoot = path.dirname(input.commonDir);
  const options: HardenedGitOptions = { cwd: repoRoot, deadline };
  const timedOut = {
    ok: false as const,
    reason: `the recorded worktree could not be re-checked within ${budgetMs} ms (timed out at the close write)`,
  };
  const verdict = await verifyCleanLinkedWorktree(input.worktreePath, input.commonDir, options);
  if (deadline.expired) return timedOut;
  if (!verdict.ok) return { ok: false, reason: `the recorded worktree ${verdict.reason}` };
  if (verdict.branch !== input.branch || verdict.headSha !== input.headSha) {
    return { ok: false, reason: "the recorded worktree's HEAD moved after the close was measured" };
  }
  if (!input.siblings) return { ok: true };
  const { issueIdentifier, refsDigest } = input.siblings;
  let siblingRefusal: string | null;
  try {
    siblingRefusal = siblingRefsDigest(await readSiblingRefs(repoRoot, options), issueIdentifier) !== refsDigest
      ? "the repository's branches changed after the close was measured"
      : await siblingWorktreeRefusal(issueIdentifier, {
        repoRoot,
        commonDir: input.commonDir,
        worktreePath: input.worktreePath,
        options,
      });
  } catch {
    siblingRefusal = "the repository's other branches and worktrees could not be re-checked";
  }
  if (deadline.expired) return timedOut;
  return siblingRefusal ? { ok: false, reason: siblingRefusal } : { ok: true };
}

// ───────────────────────────────────────────────────────────────────────
// SUP-24402: the zero-delta repository_delivery close. A routine cycle card
// classified repository_delivery whose own branch carries no change has no
// pull request and no merge commit, so the Tier 2 merge-head proof has nothing
// to compare with. The guard accepts that close only when, among its other
// proofs, this probe measures the card's own recorded worktree on the card's
// recorded branch and finds:
//   - `rev-list --count <base>..<HEAD>` printing exactly 0;
//   - `merge-base --is-ancestor <HEAD> <base>` exiting 0;
//   - `status --porcelain=v1 --untracked-files=all` printing nothing;
// where <base> is `refs/remotes/origin/<base branch>`. Every git process runs
// under the hardened runner, and status runs through the snapshot git dir, so
// no repository-local configuration (a filter driver, fsmonitor, hooks) runs
// or reshapes what status reports. Index flags that hide a modification from
// status (assume-unchanged, skip-worktree), unmerged entries, submodules, an
// in-progress git operation and info/exclude rules the server did not write
// all refuse, because each leaves an empty status unproven. Any git failure,
// unparseable output or missing ref refuses. The base ref is read from the
// worktree's own refs, which an agent can write, so the caller also compares
// HEAD with the base branch on the remote.
// ───────────────────────────────────────────────────────────────────────

export interface ZeroDeltaWorktreeProbeInput {
  /** Path recorded on the card's own execution workspace row (`providerRef ?? cwd`, not agent-writable). */
  recordedWorktreePath: string;
  /** `<instanceRoot>/projects/<companyId>/<projectId>`, derived from server env and immutable ids. */
  managedProjectRoot: string;
  /** Branch recorded on that row (`branchName`, not agent-writable). */
  branch: string;
  /** The base branch name, normalized; measured as `refs/remotes/origin/<baseBranch>`. */
  baseBranch: string;
  issueIdentifier: string;
  /** The project's own branches: their local branches carry no card's work. */
  projectBranches: ReadonlySet<string>;
  /** Branch names registered to ANOTHER issue's execution workspace in this company and project. */
  attributedBranches: ReadonlySet<string>;
  /** Which of `candidates` are the identifier of an existing issue of this company other than this card. */
  existingOtherCardIdentifiers: (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
  /**
   * Commits `sha` carries beyond the base branch, measured on the remote (a
   * source the agent cannot write). Throws when it cannot be measured.
   */
  countCommitsAheadOfBase: (sha: string) => Promise<number>;
  timeoutMs?: number;
}

/** What the three base and status commands answered. */
export interface ZeroDeltaWorktreeMeasurement {
  /** `rev-list --count <base>..<HEAD>` standard output, verbatim. */
  aheadCountOutput: string;
  /** True only when `merge-base --is-ancestor <HEAD> <base>` exited 0. */
  headIsAncestorOfBase: boolean;
  /** `status --porcelain=v1 -z --untracked-files=all` records. */
  statusRecords: readonly string[];
}

export type ZeroDeltaWorktreeProbeResult =
  | {
      ok: true;
      worktreePath: string;
      commonDir: string;
      branch: string;
      headSha: string;
      baseRef: string;
      baseSha: string;
      /** Digest of the branches the sibling scan read (see siblingRefsDigest); the close write requires it unchanged. */
      refsDigest: string;
    }
  | { ok: false; reason: string };

/**
 * Why a measurement is not zero-delta; null when every clause holds. Each
 * clause is checked on its own, so an inconsistent answer (a zero count with
 * a failed ancestry check) still refuses.
 */
export function zeroDeltaWorktreeRefusal(measurement: ZeroDeltaWorktreeMeasurement, baseRef: string): string | null {
  const aheadOutput = measurement.aheadCountOutput.trim();
  if (!/^\d+$/.test(aheadOutput)) return `printed no commit count for ${baseRef}..HEAD`;
  if (aheadOutput !== "0") return `has ${aheadOutput} commit(s) on HEAD that ${baseRef} lacks`;
  if (!measurement.headIsAncestorOfBase) return `has a HEAD that is not an ancestor of ${baseRef}`;
  if (measurement.statusRecords.some((record) => !record.startsWith("?? "))) {
    return "has uncommitted changes to tracked files";
  }
  if (measurement.statusRecords.length > 0) return "has untracked files";
  return null;
}

interface SiblingRef {
  sha: string;
  refname: string;
}

async function readSiblingRefs(repoRoot: string, options: HardenedGitOptions): Promise<SiblingRef[]> {
  return (await runHardenedGit(
    ["-C", repoRoot, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/remotes/"],
    options,
  )).split("\n").filter((line) => line.length > 0).map((line) => {
    const space = line.indexOf(" ");
    return { sha: line.slice(0, space), refname: line.slice(space + 1) };
  });
}

/**
 * Digest of what the sibling scan's branch verdicts rest on: every local
 * branch, and every remote-tracking branch naming the card. Remote-tracking
 * branches of other cards and the base are left out, so a routine fetch by
 * another card does not refuse this close.
 */
function siblingRefsDigest(refs: readonly SiblingRef[], issueIdentifier: string): string {
  const hash = createHash("sha256");
  for (const ref of refs) {
    if (ref.refname.startsWith("refs/remotes/")) {
      const remoteRef = ref.refname.slice("refs/remotes/".length);
      if (!branchNamesIssue(remoteRef.slice(remoteRef.indexOf("/") + 1), issueIdentifier)) continue;
    }
    hash.update(`${ref.sha} ${ref.refname}\n`);
  }
  return hash.digest("hex");
}

/**
 * Every other worktree on a branch naming the card must be clean, and no
 * other worktree may have a detached HEAD. Run by the measurement and again
 * inside the close write, where a worktree can be added on an existing branch
 * without moving any ref.
 */
async function siblingWorktreeRefusal(
  issueIdentifier: string,
  ctx: { repoRoot: string; commonDir: string; worktreePath: string; options: HardenedGitOptions },
): Promise<string | null> {
  const { repoRoot, commonDir, worktreePath, options } = ctx;
  const worktreeRecords = (await runHardenedGit(["-C", repoRoot, "worktree", "list", "--porcelain", "-z"], options))
    .split("\0\0")
    .map((record) => record.split("\0").filter((field) => field.length > 0))
    .filter((fields) => fields.length > 0);
  for (const fields of worktreeRecords) {
    const worktreeField = fields.find((field) => field.startsWith("worktree "));
    const branchField = fields.find((field) => field.startsWith("branch refs/heads/"));
    if (!worktreeField) continue;
    if (!branchField) {
      let detachedPath: string;
      try {
        detachedPath = await realpath(worktreeField.slice("worktree ".length));
      } catch {
        continue;
      }
      if (detachedPath === worktreePath) continue;
      return `another worktree at ${detachedPath} has a detached HEAD`;
    }
    const branch = branchField.slice("branch refs/heads/".length);
    if (!branchNamesIssue(branch, issueIdentifier)) continue;
    let otherPath: string;
    try {
      otherPath = await realpath(worktreeField.slice("worktree ".length));
    } catch {
      continue;
    }
    if (otherPath === worktreePath) continue;
    const other = await verifyCleanLinkedWorktree(otherPath, commonDir, options);
    if (!other.ok) return `another worktree on branch ${branch} ${other.reason}`;
  }
  return null;
}

/**
 * The no-repository probe's sibling scans: every other branch naming this
 * card must be level with the base, every other local branch must belong to
 * a card (a project branch, another card's registered branch, or another
 * existing card's rescue branch), every remote-tracking branch naming this
 * card must be level, and every other worktree on a branch naming this card
 * must be clean. A worktree with a detached HEAD refuses. Branch tips are
 * compared by the caller against the remote base, never against a local
 * tracking ref an agent can move, each distinct tip once and at most
 * MAX_COMPARED_TIPS of them counting the recorded HEAD; the branch and
 * worktree lists themselves read refs an agent can write, so they are
 * advisory next to that anchor.
 */
async function zeroDeltaSiblingRefusal(
  input: ZeroDeltaWorktreeProbeInput,
  refs: readonly SiblingRef[],
  ctx: {
    repoRoot: string;
    commonDir: string;
    worktreePath: string;
    headSha: string;
    options: HardenedGitOptions;
  },
): Promise<string | null> {
  const checkedTips = new Set<string>([ctx.headSha]);
  const tipRefusal = async (subject: string, sha: string): Promise<string | null> => {
    if (checkedTips.has(sha)) return null;
    if (checkedTips.size >= MAX_COMPARED_TIPS) {
      return (
        `too_many_branch_tips: the recorded worktree and the branches naming this issue have more than ` +
        `${MAX_COMPARED_TIPS} distinct tips to compare with the base branch`
      );
    }
    checkedTips.add(sha);
    return aheadOfBaseRefusal(subject, sha, input.countCommitsAheadOfBase);
  };
  const localBranches = refs
    .filter((ref) => ref.refname.startsWith("refs/heads/"))
    .map((ref) => ({ sha: ref.sha, name: ref.refname.slice("refs/heads/".length) }));
  const rescueOwners = [...new Set(localBranches.flatMap(({ name }) => {
    const owner = branchNamesIssue(name, input.issueIdentifier) ? null : rescueBranchOwner(name);
    return owner === null ? [] : [owner];
  }))];
  const rescuedCards = rescueOwners.length > 0 ? await input.existingOtherCardIdentifiers(rescueOwners) : new Set<string>();
  for (const { sha, name } of localBranches) {
    if (!SHA_RE.test(sha) || name === input.branch) continue;
    if (branchNamesIssue(name, input.issueIdentifier)) {
      const refusal = await tipRefusal(`branch ${name}`, sha);
      if (refusal) return refusal;
      continue;
    }
    const rescueOwner = rescueBranchOwner(name);
    if (
      input.projectBranches.has(name) ||
      input.attributedBranches.has(name) ||
      (rescueOwner !== null && rescuedCards.has(rescueOwner))
    ) {
      continue;
    }
    return (
      `branch ${name} belongs to no card: it is not this card's, not one of the project's branches, ` +
      "not registered to another card's workspace, and not another card's rescue branch"
    );
  }
  for (const ref of refs) {
    if (!ref.refname.startsWith("refs/remotes/") || !SHA_RE.test(ref.sha)) continue;
    const remoteRef = ref.refname.slice("refs/remotes/".length);
    const slash = remoteRef.indexOf("/");
    if (slash < 0) continue;
    const name = remoteRef.slice(slash + 1);
    if (name === "HEAD" || name === input.baseBranch || name === input.branch || input.projectBranches.has(name)) continue;
    if (!branchNamesIssue(name, input.issueIdentifier)) continue;
    const refusal = await tipRefusal(`branch ${remoteRef}`, ref.sha);
    if (refusal) return refusal;
  }
  return siblingWorktreeRefusal(input.issueIdentifier, ctx);
}

async function readBranchHead(
  worktreePath: string,
  options: HardenedGitOptions,
): Promise<{ branchRef: string; headSha: string } | null> {
  const headSha = await readHeadCommit(worktreePath, options);
  if (!headSha) return null;
  const branchRef = (await runHardenedGit(["-C", worktreePath, "symbolic-ref", "--quiet", "HEAD"], options)).trim();
  return { branchRef, headSha };
}

export async function probeZeroDeltaWorktree(input: ZeroDeltaWorktreeProbeInput): Promise<ZeroDeltaWorktreeProbeResult> {
  if (!resolveTrustedGitBinary()) return refuse("no root-owned git binary is installed at a fixed system path");
  const baseRef = `refs/remotes/origin/${input.baseBranch}`;
  const branchRef = `refs/heads/${input.branch}`;
  let managedRoot: string;
  let worktreePath: string;
  try {
    managedRoot = await realpath(input.managedProjectRoot);
  } catch {
    return refuse("the project's managed checkout directory does not exist");
  }
  try {
    worktreePath = await realpath(input.recordedWorktreePath);
  } catch {
    return refuse("the recorded worktree path does not exist");
  }
  const relative = path.relative(managedRoot, worktreePath);
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
  const options: HardenedGitOptions = { cwd: repoRoot, timeoutMs: input.timeoutMs, ceilingDirectory: path.dirname(worktreePath) };
  try {
    const shapeRefusal = await worktreeShapeRefusal(worktreePath, options);
    if (shapeRefusal) return refuse(`the recorded worktree ${shapeRefusal}`);
    const identity = await readWorktreeIdentity(worktreePath, options);
    if (identity.topLevel !== worktreePath) {
      return refuse("the recorded worktree has a work-tree top level other than its own path");
    }
    if (identity.commonDir !== commonDir || path.dirname(identity.gitDir) !== path.join(commonDir, "worktrees")) {
      return refuse("the recorded worktree is not a linked worktree of the managed checkout");
    }
    const head = await readBranchHead(worktreePath, options).catch(() => null);
    if (!head) return refuse(`the recorded worktree is not on the card's recorded branch ${input.branch}`);
    if (head.branchRef !== branchRef) {
      return refuse(`the recorded worktree is on ${head.branchRef}, not on the card's recorded branch ${input.branch}`);
    }
    if (await lstat(path.join(identity.gitDir, "index.lock")).then(() => true, () => false)) {
      return refuse("the recorded worktree has a Git operation in progress (index.lock is present)");
    }
    const stash = await stashRefusal(worktreePath, options);
    if (stash) return refuse(`the recorded worktree ${stash}`);
    const exclude = await readOptionalRegularFile(path.join(identity.commonDir, "info", "exclude"), MAX_EXCLUDE_FILE_BYTES);
    if (hasForeignExcludeRules(exclude)) {
      return refuse("the recorded worktree has info/exclude ignore rules the server did not write");
    }
    const baseSha = (
      await runHardenedGit(["-C", worktreePath, "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], options)
        .catch(() => "")
    ).trim();
    if (!SHA_RE.test(baseSha)) return refuse(`the base ref ${baseRef} does not resolve in the recorded worktree`);

    const aheadCountOutput = await runHardenedGit(
      ["-C", worktreePath, "rev-list", "--count", `${baseSha}..${head.headSha}`],
      options,
    );
    const headIsAncestorOfBase = await runHardenedGit(
      ["-C", worktreePath, "merge-base", "--is-ancestor", head.headSha, baseSha],
      options,
    ).then(() => true, () => false);
    const snapshotResult = await withSnapshotGitDir(
      { identity, headSha: head.headSha, config: snapshotConfig(identity.objectFormat), exclude },
      async (snapshot): Promise<{ refusal: string } | { statusRecords: string[] }> => {
        const trackedPaths = new Set<string>();
        for (const entry of await listIndexEntries(snapshot, worktreePath, options)) {
          const entryRefusal = indexEntryRefusal(entry);
          if (entryRefusal) return { refusal: entryRefusal };
          trackedPaths.add(entry.path);
        }
        const statusRecords = await snapshotStatusRecords(snapshot, worktreePath, "all", options);
        if (statusRecords.length > 0) return { statusRecords };
        const ignored = await firstDisallowedIgnoredEntry(snapshot, worktreePath, trackedPaths, options);
        if (ignored !== null) {
          const entry = JSON.stringify(ignored.entry.slice(0, 200));
          return {
            refusal: ignored.listed
              ? `has a regenerated-artefact directory that no committed ignore rule ignores (${entry})`
              : `has an ignored entry outside the regenerated-artefact directories (${entry})`,
          };
        }
        return { statusRecords };
      },
    );
    if ("refusal" in snapshotResult) return refuse(`the recorded worktree ${snapshotResult.refusal}`);
    const refusal = zeroDeltaWorktreeRefusal(
      { aheadCountOutput, headIsAncestorOfBase, statusRecords: snapshotResult.statusRecords },
      baseRef,
    );
    if (refusal) return refuse(`the recorded worktree ${refusal}`);

    const refs = await readSiblingRefs(repoRoot, options);
    const siblingRefusal = await zeroDeltaSiblingRefusal(input, refs, {
      repoRoot,
      commonDir,
      worktreePath,
      headSha: head.headSha,
      options,
    });
    if (siblingRefusal) return refuse(siblingRefusal);

    const final = await readBranchHead(worktreePath, options).catch(() => null);
    if (!final || final.branchRef !== head.branchRef || final.headSha !== head.headSha) {
      return refuse("the recorded worktree's HEAD moved while it was being measured");
    }
    return {
      ok: true,
      worktreePath,
      commonDir,
      branch: input.branch,
      headSha: head.headSha,
      baseRef,
      baseSha,
      refsDigest: siblingRefsDigest(refs, input.issueIdentifier),
    };
  } catch (error) {
    return refuse(`the recorded worktree could not be measured (${error instanceof Error ? error.message : "unknown"})`);
  }
}
