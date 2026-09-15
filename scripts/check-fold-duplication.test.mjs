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

test("workflow YAML is in scope, both extensions, and generated lockfiles are not", () => {
  // `.yml` is in scope because a workflow file is a real place for a merge to
  // keep both copies -- fold 1446a58c0 duplicated a whole `release.yml` step.
  // `pnpm-lock.yaml` is the entire cost of that: its dependency entries are
  // near-identical blocks laid out back to back, which is exactly the shape
  // rule 1 looks for. Including it takes the full-history noise floor from 3
  // flagged merges of 447 to 6; excluding it keeps the floor at 3 with YAML
  // covered. Nobody hand-resolves a lockfile conflict here anyway -- pr.yml
  // refuses the edit and a fold takes upstream's resolved file wholesale.
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    // `deploy.yaml` is the positive case for the `.yaml` extension itself:
    // without it, `ci.yml` alone would keep this test green even if `yaml` were
    // dropped from the extension set, because the only other `.yaml` here is
    // the one expected to be absent.
    const tracked = ["pnpm-lock.yaml", "ci.yml", "deploy.yaml"];
    const write = (name, body) => writeFileSync(path.join(dir, name), body);
    for (const name of tracked) write(name, `${GUARD}\n`);
    git("add", "-A");
    git("commit", "-qm", "base");

    git("checkout", "-q", "-b", "fork");
    for (const name of tracked) write(name, `${GUARD}\n\nfork: true\n`);
    git("commit", "-qam", "fork side");

    git("checkout", "-q", "base");
    for (const name of tracked) write(name, `${GUARD}\n\nupstream: true\n`);
    git("commit", "-qam", "upstream side");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    for (const name of tracked) {
      write(name, `${GUARD}\n${GUARD}\n\nupstream: true\nfork: true\n`);
    }
    git("add", "-A");
    git("commit", "-qm", "merge keeping both sides in every file");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.deepEqual(result.findings.map((f) => f.path).sort(), ["ci.yml", "deploy.yaml"]);
    assert.deepEqual(
      [...new Set(result.redeclarations.map((r) => r.path))].sort(),
      ["ci.yml", "deploy.yaml"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A six-line block for the fold-shape tests. Every line is substantive, so the
// adjacency rule sees it at minLines 5.
const QUERY = [
  "SELECT \"id\",",
  "first_value(\"id\") OVER (",
  "PARTITION BY \"company_id\", \"idempotency_key\"",
  "ORDER BY \"created_at\" ASC",
  ") AS \"keeper_id\"",
  "FROM \"chat_interactions\";",
].join("\n");

const filler = (tag, n) => Array.from({ length: n }, (_, i) => `const ${tag}Filler${i} = ${i};`).join("\n");

test("findMergeDuplication follows a rename so a re-stamped file's own repetition is not reported", () => {
  // fold:restamp renames 0260_x.sql to 0275_x.sql inside the fold merge. Matched
  // by path, both parents read as empty and the file's internal repeat reads as new.
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    writeFileSync(path.join(dir, "README.md"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "fork.ts"), "export const FORK_FLAG = true;\n");
    git("add", "-A");
    git("commit", "-qm", "fork side");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "0260_x.sql"), `${QUERY}\n${QUERY}\n`);
    git("add", "-A");
    git("commit", "-qm", "upstream adds a migration that repeats a query");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    git("mv", "0260_x.sql", "0275_x.sql");
    git("commit", "-qm", "fold merge that re-stamps the migration");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication still flags a renamed file the merge duplicated", () => {
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    writeFileSync(path.join(dir, "README.md"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "fork.ts"), "export const FORK_FLAG = true;\n");
    git("add", "-A");
    git("commit", "-qm", "fork side");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "0260_x.sql"), `${QUERY}\n`);
    git("add", "-A");
    git("commit", "-qm", "upstream adds a migration with the query once");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    git("mv", "0260_x.sql", "0275_x.sql");
    writeFileSync(path.join(dir, "0275_x.sql"), `${QUERY}\n${QUERY}\n`);
    git("add", "-A");
    git("commit", "-qm", "fold merge that re-stamps and doubles the query");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, "0275_x.sql");
    assert.equal(result.findings[0].mergeCount, 2);
    // Parent 1 is the upstream side that added 0260_x.sql; the rename is followed there.
    assert.deepEqual(result.findings[0].parentCounts, [1, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication stays quiet when a parent already holds the back-to-back pair", () => {
  // The counting artifact: base repeats a query back to back; each side adds one
  // more lone copy elsewhere. Every block count rises past both parents, but the
  // pair itself is the base's own.
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    const pair = `${filler("a", 6)}\n${QUERY}\n${QUERY}\n${filler("b", 6)}\n`;
    writeFileSync(path.join(dir, "suite.test.ts"), pair);
    git("add", "-A");
    git("commit", "-qm", "base repeats the query in one test");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "suite.test.ts"), `${pair}${filler("fork", 6)}\n${QUERY}\n`);
    git("commit", "-qam", "fork adds a test that runs the query once");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "suite.test.ts"), `${filler("up", 6)}\n${QUERY}\n${pair}`);
    git("commit", "-qam", "upstream adds a test that runs the query once");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    writeFileSync(
      path.join(dir, "suite.test.ts"),
      `${filler("up", 6)}\n${QUERY}\n${pair}${filler("fork", 6)}\n${QUERY}\n`,
    );
    git("add", "-A");
    git("commit", "-qm", "merge takes both added tests");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication stays quiet on a composed block both parents already repeat", () => {
  // Both parents hold the same mock body twice; each side adds a different key to
  // both copies. The merged copies carry both keys and match neither parent verbatim.
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    const twice = (extra) => {
      const body = `${QUERY}\n${extra}`;
      return `${body}\n\n${body}\n`;
    };
    writeFileSync(path.join(dir, "routes.test.ts"), twice(""));
    git("add", "-A");
    git("commit", "-qm", "base repeats a mock body");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "routes.test.ts"), twice("forkService: () => mockForkService,"));
    git("commit", "-qam", "fork adds a key to both copies");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "routes.test.ts"), twice("upstreamService: () => mockUpstreamService,"));
    git("commit", "-qam", "upstream adds a different key to both copies");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    writeFileSync(
      path.join(dir, "routes.test.ts"),
      twice("forkService: () => mockForkService,\nupstreamService: () => mockUpstreamService,"),
    );
    git("add", "-A");
    git("commit", "-qm", "merge composes both keys into both copies");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication still flags a composed block the merge kept twice when each parent held it once", () => {
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    writeFileSync(path.join(dir, "routes.ts"), `${QUERY}\n`);
    git("add", "-A");
    git("commit", "-qm", "base holds the block once");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "routes.ts"), `${QUERY}\nforkService: () => mockForkService,\n`);
    git("commit", "-qam", "fork edits the block");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "routes.ts"), `${QUERY}\nupstreamService: () => mockUpstreamService,\n`);
    git("commit", "-qam", "upstream edits the block");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    const composed = `${QUERY}\nforkService: () => mockForkService,\nupstreamService: () => mockUpstreamService,`;
    writeFileSync(path.join(dir, "routes.ts"), `${composed}\n${composed}\n`);
    git("add", "-A");
    git("commit", "-qm", "merge keeps both sides, composed twice");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, "routes.ts");
    assert.deepEqual(result.findings[0].parentCounts, [0, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication still flags a composed duplicate beside an unrelated similar pair both parents hold", () => {
  // Both parents already repeat a near-identical block elsewhere in the file. That
  // pair must not excuse a NEW composed duplicate: the merge keeps the old pair and
  // adds the new one, so it holds one more similar pair than either parent.
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    const other = `${QUERY}\notherService: () => mockOtherService,`;
    const prefix = `${other}\n\n${other}\n${filler("mid", 6)}\n`;
    writeFileSync(path.join(dir, "routes.ts"), `${prefix}${QUERY}\n`);
    git("add", "-A");
    git("commit", "-qm", "base: an unrelated similar pair, and the block once");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "routes.ts"), `${prefix}${QUERY}\nforkService: () => mockForkService,\n`);
    git("commit", "-qam", "fork edits the block");

    git("checkout", "-q", "base");
    writeFileSync(path.join(dir, "routes.ts"), `${prefix}${QUERY}\nupstreamService: () => mockUpstreamService,\n`);
    git("commit", "-qam", "upstream edits the block");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    const composed = `${QUERY}\nforkService: () => mockForkService,\nupstreamService: () => mockUpstreamService,`;
    writeFileSync(path.join(dir, "routes.ts"), `${prefix}${composed}\n${composed}\n`);
    git("add", "-A");
    git("commit", "-qm", "merge keeps both sides, composed twice, beside the old pair");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].parentCounts, [0, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMergeDuplication follows a rename for declaration counts", () => {
  // Overload signatures repeat a column-0 declaration by design. Matched by path,
  // a renamed file's parents read as empty and every overload reads as a redeclaration.
  const { dir, git, gitAllowingConflict } = makeRepo();
  try {
    writeFileSync(path.join(dir, "README.md"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    git("checkout", "-q", "-b", "fork");
    writeFileSync(path.join(dir, "fork.ts"), "export const FORK_FLAG = true;\n");
    git("add", "-A");
    git("commit", "-qm", "fork side");

    git("checkout", "-q", "base");
    writeFileSync(
      path.join(dir, "old-name.ts"),
      [
        "export function parse(input: string): string;",
        "export function parse(input: number): number;",
        "export function parse(input: string | number) {",
        "  return input;",
        "}",
        "",
      ].join("\n"),
    );
    git("add", "-A");
    git("commit", "-qm", "upstream adds overloads");

    gitAllowingConflict("merge", "-q", "--no-commit", "--no-ff", "fork");
    git("mv", "old-name.ts", "new-name.ts");
    git("commit", "-qm", "fold merge that renames the file");

    const result = findMergeDuplication("HEAD", { cwd: dir, minLines: 5, maxGap: 4 });
    assert.deepEqual(result.redeclarations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
