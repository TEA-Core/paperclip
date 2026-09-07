import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

function policySteps(pr) {
  // The `policy` job runs from its own `steps:` key up to the next top-level
  // job. Scoping to it matters: a step wired into any other job does not gate
  // `verify`, and would satisfy a naive whole-file match while gating nothing.
  const job = pr.match(/\n {2}policy:\n((?: {4}.*\n|\n)*)/);
  assert.ok(job, "pr.yml should declare a `policy` job");
  return job[1];
}

// `.github/scripts/check-pr-migration-order.mjs` spent its whole life orphaned:
// its only caller was `pr-trusted.yml`, which is `workflow_call:` only and which
// nothing calls. Cross-branch migration-order validation therefore never ran on
// this pipeline, and it is the one check that catches a fold's migration
// collision -- upstream and the fork both claiming the same 4-digit number.
// These tests pin the wiring, because it fails silently rather than loudly if
// it is removed again.

test("the policy job runs the migration-order check", () => {
  const steps = policySteps(readWorkflow("pr.yml"));

  assert.match(
    steps,
    /run: node \.github\/scripts\/check-pr-migration-order\.mjs "\$BASE_SHA" "\$HEAD_SHA"/,
    "the policy job must invoke check-pr-migration-order.mjs with the resolved SHAs",
  );
});

test("the migration-order check runs on merge_group as well as pull_request", () => {
  const pr = readWorkflow("pr.yml");
  const step = pr.match(
    /- name: Validate migration ordering against target branch\n((?: {8}.*\n|\n)*)/,
  );
  assert.ok(step, "the migration-order step should exist");

  // Ruleset 20756420 sets `strict_required_status_checks_policy: false`, so the
  // base branch can advance between the PR-time run and the merge. A number
  // that was free at PR time can be taken by then, which is exactly the
  // collision this check exists to catch -- so an `if: github.event_name ==
  // 'pull_request'` guard here would blind it to the only event that sees the
  // real post-merge numbering.
  assert.doesNotMatch(
    step[1],
    /if:\s*github\.event_name == 'pull_request'/,
    "the migration-order check must not be scoped to the pull_request event",
  );
});

test("the check reads the SHAs the policy job resolves for both payload shapes", () => {
  const pr = readWorkflow("pr.yml");

  // `github.event.pull_request.*` is empty on a merge_group event. Passing it
  // raw would hand the script two empty strings, which it rejects with exit 2 --
  // a usage error dressed up as a policy failure on every queue entry.
  assert.match(
    pr,
    /BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}/,
  );
  assert.match(
    pr,
    /HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.merge_group\.head_sha\s*\}\}/,
  );
});

test("the check runs after Node.js is set up", () => {
  const steps = policySteps(readWorkflow("pr.yml"));
  const setupNode = steps.indexOf("- name: Setup Node.js");
  const check = steps.indexOf("- name: Validate migration ordering against target branch");

  assert.ok(setupNode >= 0, "the policy job should set up Node.js");
  assert.ok(check >= 0, "the migration-order step should exist");
  assert.ok(
    setupNode < check,
    "the migration-order check must run after Setup Node.js, or the runner's default node executes it",
  );
});

test("the checkout keeps full history, which the check needs to read the base tree", () => {
  const steps = policySteps(readWorkflow("pr.yml"));

  // The script runs `git ls-tree -r <base>` and `git diff <base>...<head>`.
  // A shallow checkout does not contain the base commit, so both commands are
  // hard errors rather than an empty result.
  assert.match(steps, /fetch-depth: 0/, "the policy checkout must use fetch-depth: 0");
});

test("the migration-order check ships with its unit test wired in", () => {
  const steps = policySteps(readWorkflow("pr.yml"));

  // The unit test was orphaned by the same dead workflow as the check itself.
  assert.match(
    steps,
    /run: node --test \.github\/scripts\/tests\/check-pr-migration-order\.test\.mjs/,
  );
  assert.ok(
    existsSync(path.join(repoRoot, ".github/scripts/tests/check-pr-migration-order.test.mjs")),
    "the unit test the workflow names must exist",
  );
  assert.ok(
    existsSync(path.join(repoRoot, ".github/scripts/check-pr-migration-order.mjs")),
    "the script the workflow names must exist",
  );
});
