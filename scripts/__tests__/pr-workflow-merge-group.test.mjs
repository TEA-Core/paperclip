import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

// The deployed fold branch merges through a GitHub merge queue. A queue entry is
// a `merge_group` event, and a required check that does not run for that event
// can never report on the entry -- so requiring it parks every queued pull
// request until the queue times it out. These tests pin the wiring that makes
// the queue able to gate, because each piece fails silently rather than loudly
// if it is removed.

test("pr.yml runs for merge_group, so queue entries can report the required checks", () => {
  const pr = readWorkflow("pr.yml");

  assert.match(pr, /^on:\n(?:.*\n)*?\s{2}merge_group:/m, "pr.yml must trigger on merge_group");

  // Same branch coverage as pull_request, or a queue entry on a fold branch
  // produces no run at all.
  const mergeGroupBlock = pr.match(/\n {2}merge_group:\n((?: {4}.*\n|\n)*)/);
  assert.ok(mergeGroupBlock, "merge_group trigger block should be readable");
  assert.match(mergeGroupBlock[1], /branches:/);
  assert.match(mergeGroupBlock[1], /'fold\/\*\*'/);
});

test("the concurrency group distinguishes queue entries from each other", () => {
  const pr = readWorkflow("pr.yml");
  const concurrency = pr.match(/\nconcurrency:\n((?: {2}.*\n)*)/);
  assert.ok(concurrency, "pr.yml should declare a concurrency block");

  // `github.event.pull_request.number` is empty on merge_group. Keyed on that
  // alone, every queue entry shares one group -- and with cancel-in-progress
  // each new entry cancels the entry ahead of it, so the queue eats itself.
  assert.match(
    concurrency[1],
    /github\.event\.merge_group\.head_ref|github\.ref/,
    "concurrency.group must fall back to a merge_group-specific key",
  );
});

test("the policy job resolves base/head SHAs for both event shapes", () => {
  const pr = readWorkflow("pr.yml");

  // An absent SHA does not yield an empty diff -- `git diff "$A...$B"` with a
  // missing ref is a hard error, so the policy job fails on every queue entry.
  assert.match(pr, /BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}/);
  assert.match(pr, /HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.merge_group\.head_sha\s*\}\}/);

  // Every diff-based step must read the resolved variables, never the raw
  // pull_request payload.
  const diffCalls = pr.match(/git diff --name-only "[^"]*"/g) ?? [];
  assert.ok(diffCalls.length > 0, "expected diff-based policy steps");
  for (const call of diffCalls) {
    assert.match(
      call,
      /\$BASE_SHA\.\.\.\$HEAD_SHA/,
      `diff step must use the resolved SHAs, found: ${call}`,
    );
  }
});

test("the stale-merge-base check does not run for merge_group", () => {
  const pr = readWorkflow("pr.yml");
  const step = pr.match(/- name: Reject stale merge base\n((?: {8}.*\n|\n)*)/);
  assert.ok(step, "the stale merge base step should exist");

  // A queue entry is built on the current base by construction, so there is no
  // stale base to reject. Worse, the check measures the merge-base commit's age,
  // so on a quiet base branch it would fail the queue for a current PR.
  assert.match(step[1], /if: github\.event_name == 'pull_request'/);
});
