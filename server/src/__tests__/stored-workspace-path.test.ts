import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalRunContextSnapshot, canonicalStoredPath } from "../services/stored-workspace-path.js";

describe("stored local writer paths", () => {
  let root: string;
  let tree: string;
  let alias: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "stored-writer-path-"));
    tree = path.join(root, "tree");
    mkdirSync(path.join(tree, "sub"), { recursive: true });
    alias = path.join(root, "alias");
    symlinkSync(path.join(tree, "sub"), alias);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("normalizes every persisted local context path without mutating caller metadata", async () => {
    const raw = `${alias}/../future//child/./`;
    const normalized = path.join(tree, "future", "child");
    const context = {
      cwd: raw, workspaceCwd: raw, issueId: "issue-owner",
      paperclipWorkspace: { cwd: raw, worktreePath: raw, branchName: "owned" },
      paperclipWorkspaces: [{ cwd: raw, worktreePath: raw, name: "hint" }, null],
      paperclipEnvironment: { driver: "local" },
    };
    expect(await canonicalRunContextSnapshot(context)).toEqual({
      ...context, cwd: normalized, workspaceCwd: normalized,
      paperclipWorkspace: { cwd: normalized, worktreePath: normalized, branchName: "owned" },
      paperclipWorkspaces: [{ cwd: normalized, worktreePath: normalized, name: "hint" }, null],
    });
    expect(context.cwd).toBe(raw);
    expect(context.paperclipWorkspace.cwd).toBe(raw);
    expect(context.paperclipWorkspaces[0]?.cwd).toBe(raw);
  });

  it("records a missing symlink target rather than the alias spelling", async () => {
    const dangling = path.join(root, "dangling");
    symlinkSync(path.join(tree, "missing"), dangling);
    expect(await canonicalStoredPath(`${dangling}/child`)).toBe(path.join(tree, "missing", "child"));
  });

  it("does not reinterpret a remote environment's filesystem paths on this host", async () => {
    const context = { cwd: `${alias}/../future`, paperclipEnvironment: { driver: "daytona" } };
    expect(await canonicalRunContextSnapshot(context)).toEqual(context);
  });

  it("refuses to publish an unresolved local symlink loop", async () => {
    const loop = path.join(root, "loop");
    symlinkSync(loop, loop);
    await expect(canonicalRunContextSnapshot({ cwd: loop })).rejects.toMatchObject({
      status: 409, details: { code: "review_entry_path_unverified" },
    });
  });
});
