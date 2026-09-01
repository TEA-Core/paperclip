import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the worktree checkout race.
 *
 * `ensureSharedGroupOwnership` chgrps a directory to the shared `agents` group
 * so both the server uid and the agent uid can write it. In the two worktree
 * paths of workspace-runtime.ts the parent directory must be chgrped *before*
 * `git worktree add` populates it — otherwise the checkout races the chgrp and
 * can create a tree the agent principal cannot write, and a rejected chgrp
 * becomes an unhandled promise rejection instead of a warning.
 *
 * Both sites used to fire the helper as `void ensureSharedGroupOwnership(dir)`.
 * The first describe below pins the awaited ordering in the source; the second
 * shows why the ordering matters at all: nothing is applied until the promise
 * the helper returns has settled.
 */

// The handle-based implementation opens the target by fd (O_NOFOLLOW) and
// mutates through the FileHandle, so the settle test mocks fs.open (returns a
// fake handle) and fs.realpath (resolves /proc/self/fd/<fd> back to a path).
const mockOpen = vi.fn();
const mockRealpath = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    open: mockOpen,
    realpath: mockRealpath,
  },
}));

vi.mock("../home-paths.js", () => ({
  resolveDefaultSecretsKeyFilePath: vi.fn(() => "/tmp/nonexistent-secrets/master.key"),
  resolveDefaultEmbeddedPostgresDir: vi.fn(() => "/tmp/nonexistent-db"),
  resolveDefaultBackupDir: vi.fn(() => "/tmp/nonexistent-backups"),
}));

const REAL_GID = 1002;

const __dirname2 = dirname(fileURLToPath(import.meta.url));

const WORKSPACE_RUNTIME_PATH = join(__dirname2, "..", "services", "workspace-runtime.ts");
const HEARTBEAT_PATH = join(__dirname2, "..", "services", "heartbeat.ts");
const RUN_SCRATCH_PATH = join(__dirname2, "..", "services", "run-scratch.ts");

const sourceLines = readFileSync(WORKSPACE_RUNTIME_PATH, "utf8").split("\n");
const heartbeatLines = readFileSync(HEARTBEAT_PATH, "utf8").split("\n");
const runScratchLines = readFileSync(RUN_SCRATCH_PATH, "utf8").split("\n");

// `ensureSharedGroupTraversalPath` is the chain-walking wrapper around
// `ensureSharedGroupOwnership`; it applies the same chgrp/chmod to every
// directory between the repo root and the leaf, so it carries exactly the same
// await-before-`worktree add` obligation and must be scanned identically.
const HELPER_RE_SRC = "ensureSharedGroup(?:Ownership|TraversalPath)";
const CALL_RE = new RegExp(`${HELPER_RE_SRC}\\s*\\(`);
const AWAITED_CALL_RE = new RegExp(`await\\s+${HELPER_RE_SRC}\\s*\\(`);
// Matches whichever helper is used, as long as its FIRST argument is the
// worktree parent directory — `(worktreeParentDir)` and
// `(worktreeParentDir, repoRoot)` both qualify.
const PARENT_DIR_CALL_RE = new RegExp(
  `await\\s+${HELPER_RE_SRC}\\(\\s*(?:worktreeParentDir|path\\.dirname\\(worktreePath\\))\\s*[,)]`,
);
const WORKTREE_ADD_RE = /"worktree",\s*"add"/;
const FUNCTION_START_RE = /^(?:export\s+)?async\s+function\s+/;

function isImportLine(line: string): boolean {
  return /^\s*import\b/.test(line);
}

/** Line numbers (1-based) of every helper call, excluding the import. */
function callSiteLines(): number[] {
  return sourceLines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => CALL_RE.test(line) && !isImportLine(line))
    .map(({ lineNumber }) => lineNumber);
}

/** Zero-based [start, end) line range of a top-level function body. */
function functionRange(name: string): { start: number; end: number } {
  const start = sourceLines.findIndex((line) =>
    new RegExp(`^(?:export\\s+)?async\\s+function\\s+${name}\\b`).test(line),
  );
  expect(start, `${name} not found in workspace-runtime.ts`).toBeGreaterThanOrEqual(0);
  const after = sourceLines
    .slice(start + 1)
    .findIndex((line) => FUNCTION_START_RE.test(line));
  return { start, end: after === -1 ? sourceLines.length : start + 1 + after };
}

function firstMatch(range: { start: number; end: number }, pattern: RegExp): number {
  const offset = sourceLines.slice(range.start, range.end).findIndex((line) => pattern.test(line));
  return offset === -1 ? -1 : range.start + offset;
}

describe("workspace-runtime shared-group ownership ordering", () => {
  it("awaits every ensureSharedGroupOwnership call (no fire-and-forget sites)", () => {
    const floating = callSiteLines().filter(
      (lineNumber) => !AWAITED_CALL_RE.test(sourceLines[lineNumber - 1]),
    );

    expect(
      floating.map((lineNumber) => `workspace-runtime.ts:${lineNumber} ${sourceLines[lineNumber - 1].trim()}`),
    ).toEqual([]);
    // Guard against the scan silently matching nothing if the helper is renamed.
    expect(callSiteLines().length).toBeGreaterThan(0);
  });

  it.each(["realizeExecutionWorkspace", "ensurePersistedExecutionWorkspaceAvailable"])(
    "chgrps the worktree parent directory before git worktree add in %s",
    (functionName) => {
      const range = functionRange(functionName);
      const parentChgrpLine = firstMatch(range, PARENT_DIR_CALL_RE);
      const worktreeAddLine = firstMatch(range, WORKTREE_ADD_RE);

      expect(parentChgrpLine, `awaited parent-dir chgrp not found in ${functionName}`).toBeGreaterThanOrEqual(0);
      expect(worktreeAddLine, `git worktree add not found in ${functionName}`).toBeGreaterThanOrEqual(0);
      expect(parentChgrpLine).toBeLessThan(worktreeAddLine);
    },
  );
});

describe("heartbeat + run-scratch shared-group ownership ordering", () => {
  it("awaits every ensureSharedGroupOwnership call in heartbeat.ts (no fire-and-forget sites)", () => {
    const floating = heartbeatLines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => CALL_RE.test(line) && !isImportLine(line))
      .filter(({ lineNumber }) => !AWAITED_CALL_RE.test(heartbeatLines[lineNumber - 1]))
      .map(({ lineNumber }) => `heartbeat.ts:${lineNumber} ${heartbeatLines[lineNumber - 1].trim()}`);

    expect(floating).toEqual([]);
    expect(
      heartbeatLines.filter((line) => CALL_RE.test(line) && !isImportLine(line)).length,
    ).toBeGreaterThan(0);
  });

  it("awaits every ensureSharedGroupOwnership call in run-scratch.ts (no fire-and-forget sites)", () => {
    const floating = runScratchLines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => CALL_RE.test(line) && !isImportLine(line))
      .filter(({ lineNumber }) => !AWAITED_CALL_RE.test(runScratchLines[lineNumber - 1]))
      .map(({ lineNumber }) => `run-scratch.ts:${lineNumber} ${runScratchLines[lineNumber - 1].trim()}`);

    expect(floating).toEqual([]);
    expect(
      runScratchLines.filter((line) => CALL_RE.test(line) && !isImportLine(line)).length,
    ).toBeGreaterThan(0);
  });
});

describe("ensureSharedGroupOwnership settle semantics", () => {
  beforeEach(() => {
    mockOpen.mockReset();
    mockRealpath.mockReset();
  });

  it("applies chgrp/chmod only once the returned promise settles", async () => {
    vi.resetModules();
    const { ensureSharedGroupOwnership } = await import("../services/shared-group-ownership.js");
    const dir = path.join(os.tmpdir(), "paperclip-shared-group-await");

    // Mutation is applied through the open handle (fd), never by re-resolving a
    // lexical path, so the assertions target the handle's chown/chmod.
    const handle = {
      fd: 7,
      stat: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o755, isDirectory: () => true }),
      chown: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(handle);
    // /proc/self/fd/<fd> resolves to a contained, non-denied real path.
    mockRealpath.mockImplementation(async (p: string) => p);

    let releaseGid: (() => void) | null = null;
    const gidGate = new Promise<void>((resolve) => {
      releaseGid = resolve;
    });

    const pending = ensureSharedGroupOwnership(dir, {
      resolveGid: async () => {
        await gidGate;
        return REAL_GID;
      },
      resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
    });

    // This is exactly the window a `void`-ed call left open: control returns to
    // the caller (which then ran `git worktree add`) with the directory still
    // owned by the old group.
    expect(handle.chown).not.toHaveBeenCalled();
    expect(handle.chmod).not.toHaveBeenCalled();

    releaseGid!();
    await pending;

    expect(handle.chown).toHaveBeenCalledWith(1000, REAL_GID);
    expect(handle.chmod).toHaveBeenCalledWith(0o755 | 0o2070);
  });
});
