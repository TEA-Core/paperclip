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

const mockChown = vi.fn();
const mockChmod = vi.fn();
const mockStat = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    chown: mockChown,
    chmod: mockChmod,
    stat: mockStat,
  },
}));

vi.mock("../home-paths.js", () => ({
  resolveDefaultSecretsKeyFilePath: vi.fn(() => "/tmp/nonexistent-secrets/master.key"),
}));

const REAL_GID = 1002;

const WORKSPACE_RUNTIME_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "workspace-runtime.ts",
);

const sourceLines = readFileSync(WORKSPACE_RUNTIME_PATH, "utf8").split("\n");

const CALL_RE = /ensureSharedGroupOwnership\s*\(/;
const AWAITED_CALL_RE = /await\s+ensureSharedGroupOwnership\s*\(/;
const PARENT_DIR_CALL_RE =
  /await\s+ensureSharedGroupOwnership\(\s*(?:worktreeParentDir|path\.dirname\(worktreePath\))\s*\)/;
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

describe("ensureSharedGroupOwnership settle semantics", () => {
  beforeEach(() => {
    mockChown.mockReset();
    mockChmod.mockReset();
    mockStat.mockReset();
  });

  it("applies chgrp/chmod only once the returned promise settles", async () => {
    vi.resetModules();
    const { ensureSharedGroupOwnership } = await import("../services/shared-group-ownership.js");
    const dir = path.join(os.tmpdir(), "paperclip-shared-group-await");

    mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

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
    expect(mockChown).not.toHaveBeenCalled();
    expect(mockChmod).not.toHaveBeenCalled();

    releaseGid!();
    await pending;

    expect(mockChown).toHaveBeenCalledWith(dir, 1000, REAL_GID);
    expect(mockChmod).toHaveBeenCalledWith(dir, 0o755 | 0o2000);
  });
});
