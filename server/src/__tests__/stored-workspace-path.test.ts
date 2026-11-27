import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStoredPath } from "../services/stored-workspace-path.js";

describe("resolveStoredPath", () => {
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

  it("follows a symlink before consuming a later dot-dot and missing suffix", async () => {
    expect(await resolveStoredPath(`${alias}/../future//child/./`)).toMatchObject({
      path: path.join(tree, "future", "child"), missing: true, uncertain: false, followedSymlink: true,
    });
  });

  it("resolves a missing symlink target rather than the alias spelling", async () => {
    const dangling = path.join(root, "dangling");
    symlinkSync(path.join(tree, "missing"), dangling);
    expect(await resolveStoredPath(`${dangling}/child`)).toMatchObject({
      path: path.join(tree, "missing", "child"), missing: true, followedSymlink: true,
    });
  });

  it("marks an unresolved symlink loop uncertain and scoped", async () => {
    const loop = path.join(root, "loop");
    symlinkSync(loop, loop);
    expect(await resolveStoredPath(loop, root)).toMatchObject({ uncertain: true, scopeTouched: true });
  });
});
