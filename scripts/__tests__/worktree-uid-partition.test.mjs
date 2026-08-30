import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
const harness = readFileSync(path.join(repoRoot, "scripts/probe-worktree-uid-partition.sh"), "utf8");
const child = readFileSync(path.join(repoRoot, "scripts/probe-worktree-uid-partition-child.mjs"), "utf8");

// SUP-14127 / SUP-14126 ruling item 4: the two-real-uid regression probe is the
// merge precondition for the uid-scoped worktree-state cluster. These tests pin
// the wiring that makes the probe gate cluster PRs, because each piece fails
// silently rather than loudly if it is removed -- a probe that exists in the
// tree but is not reachable by name from a PR does not satisfy the card.

test("pr.yml declares the probe as a reachable, named CI check", () => {
  assert.match(
    workflow,
    /\n {2}worktree_uid_partition:\n(?: {4}#[^\n]*\n)* {4}name: Worktree UID partition probe/m,
    "the probe must be a job with a stable name reviewers can quote",
  );
  assert.match(
    workflow,
    /bash \.\/scripts\/probe-worktree-uid-partition\.sh/,
    "the job must actually invoke the two-real-uid harness",
  );
});

test("the probe check is wired to the uid-scoped worktree-state paths", () => {
  const step = workflow.match(
    /Run two-real-uid worktree state partition probe\n {8}run: \|\n((?: {10}.*\n)*)/,
  );
  assert.ok(step, "the probe step body should be readable");
  assert.match(step[1], /dev-runner-worktree\\.ts/);
  assert.match(step[1], /worktree-config\\.ts/);
  assert.match(step[1], /provision-worktree\\.sh/);
});

test("the harness refuses to run without a way to obtain a second real uid", () => {
  assert.match(harness, /id -u/, "the harness must check the effective uid");
  assert.match(harness, /setpriv --reuid/, "the harness must drop to each real uid with setpriv");
  assert.match(
    harness,
    /second real uid cannot be obtained/,
    "the failure message must name the missing prerequisite",
  );
  assert.match(
    harness,
    /exit 1/,
    "a missing second uid must fail the run, never skip it",
  );
});

test("the child refuses uid-0 and same-uid runs", () => {
  assert.match(
    child,
    /refusing to run any phase as uid 0/,
    "root bypasses the 0o600 boundary, so a root run must be a hard refusal",
  );
  assert.match(
    child,
    /two DISTINCT real uids/,
    "the two real uids must be distinct or the probe is void",
  );
});
