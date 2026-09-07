import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  countDeclarations,
  countOccurrences,
  findAdjacentRepeats,
  findMergeDuplication,
  mergesToCheck,
  normalize,
} from "./check-fold-duplication.mjs";

test("normalize drops blank and comment-only lines but keeps positions", () => {
  const out = normalize("const a = 1;\n\n// a comment\n  const b = 2;\n");
  assert.deepEqual(out, [
    { line: 1, text: "const a = 1;" },
    { line: 4, text: "const b = 2;" },
  ]);
});

test("countOccurrences counts non-overlapping runs", () => {
  assert.equal(countOccurrences(["a", "b", "a", "b", "a", "b"], ["a", "b"]), 3);
  assert.equal(countOccurrences(["a", "a", "a"], ["a", "a"]), 1);
});

test("findAdjacentRepeats finds a back-to-back block", () => {
  const block = [
    "if (directOAuthEntry && step === \"key\") {",
    "return renderOAuthConnectStateScreen({",
    "entry: directOAuthEntry,",
    "onRetry: handleRetryOAuth,",
    "onCancel: handleCancelOAuth,",
    "});",
  ];
  const lines = ["const before = 1;", ...block, ...block, "const after = 2;"];
  const hits = findAdjacentRepeats(lines, { minLines: 6, maxGap: 4 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].length, 6);
  assert.equal(hits[0].gap, 0);
});

test("findAdjacentRepeats ignores repeats of only trivial lines", () => {
  const lines = Array(20).fill("}");
  assert.deepEqual(findAdjacentRepeats(lines, { minLines: 6, maxGap: 4 }), []);
});

test("countDeclarations only counts column-0 declarations", () => {
  const counts = countDeclarations(
    "function keep() {}\n  function nestedAndIndented() {}\nfunction keep() {}\nrequire_channel_tag_at_head() {\n",
  );
  assert.equal(counts.get("keep"), 2);
  assert.equal(counts.get("nestedAndIndented"), undefined);
  assert.equal(counts.get("require_channel_tag_at_head"), 1);
});

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fold-dup-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  // A merge of two edits to the same region conflicts; the test resolves it by hand.
  const gitAllowingConflict = (...args) => { try { return git(...args); } catch { return ""; } };
  git("init", "-q", "-b", "base");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  return { dir, git, gitAllowingConflict };
}

const GUARD = [
  "export function guard(input) {",
  "  const decision = evaluate(input);",
  "  if (!decision.allowed) {",
  "    throw new Error(decision.reason);",
  "  }",
  "  return decision;",
  "}",
].join("\n");

test("findMergeDuplication flags a block the merge holds twice and each parent once", () => {
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n`);
    git("add", "-A");
    git("commit", "-qm", "base");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n\nexport const FORK_FLAG = true;\n`);
    git("commit", "-qam", "fork side");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n\nexport const UPSTREAM_FLAG = true;\n`);
    git("commit", "-qam", "upstream side");

    // A merge that kept both copies of the guard -- what git produces when both
    // sides rewrote the region and the resolver took ours *and* theirs.
    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    writeFileSync(
      path.join(dir, "mod.ts"),
      `${GUARD}\n${GUARD}\n\nexport const UPSTREAM_FLAG = true;\nexport const FORK_FLAG = true;\n`,
    );
    git("add", "-A");
    git("commit", "-qm", "merge keeping both sides");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.equal(result.skipped, false);
    assert.equal(result.resolvedFiles, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, "mod.ts");
    assert.equal(result.findings[0].mergeCount, 2);
    assert.deepEqual(result.findings[0].parentCounts, [1, 1]);
    assert.equal(result.redeclarations.length, 1);
    assert.equal(result.redeclarations[0].name, "guard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication stays quiet when both parents already repeat the block", () => {
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n${GUARD}\n`);
    git("add", "-A");
    git("commit", "-qm", "base already repeats");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n${GUARD}\n\nexport const FORK_FLAG = true;\n`);
    git("commit", "-qam", "fork side");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n${GUARD}\n\nexport const UPSTREAM_FLAG = true;\n`);
    git("commit", "-qam", "upstream side");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    writeFileSync(
      path.join(dir, "mod.ts"),
      `${GUARD}\n${GUARD}\n\nexport const UPSTREAM_FLAG = true;\nexport const FORK_FLAG = true;\n`,
    );
    git("add", "-A");
    git("commit", "-qm", "merge preserving the pre-existing repeat");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.redeclarations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication skips a non-merge commit", () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n`);
    git("add", "-A");
    git("commit", "-qm", "base");
    const result = findMergeDuplication("HEAD", { cwd: dir });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergesToCheck lists a symbolic head that is itself a merge exactly once", () => {
  // `git rev-list` emits full SHAs. Before `head` was canonicalized, a symbolic
  // or abbreviated head that the range already listed did not match, got
  // appended again, and every finding on it was reported twice.
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n`);
    git("add", "-A");
    git("commit", "-qm", "base");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n\nexport const FORK_FLAG = true;\n`);
    git("commit", "-qam", "fork side");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n\nexport const UPSTREAM_FLAG = true;\n`);
    git("commit", "-qam", "upstream side");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    writeFileSync(
      path.join(dir, "mod.ts"),
      `${GUARD}\n${GUARD}\n\nexport const UPSTREAM_FLAG = true;\nexport const FORK_FLAG = true;\n`,
    );
    git("add", "-A");
    git("commit", "-qm", "merge keeping both sides");

    const mergeSha = git("rev-parse", "HEAD").trim();
    const symbolic = mergesToCheck("HEAD", "HEAD^1", { cwd: dir });
    assert.deepEqual(symbolic, [mergeSha]);

    const abbreviated = mergesToCheck(mergeSha.slice(0, 9), "HEAD^1", { cwd: dir });
    assert.deepEqual(abbreviated, [mergeSha]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergesToCheck falls back to the head alone with no base", () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "mod.ts"), `${GUARD}\n`);
    git("add", "-A");
    git("commit", "-qm", "base");
    assert.deepEqual(mergesToCheck("HEAD", "", { cwd: dir }), [git("rev-parse", "HEAD").trim()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
