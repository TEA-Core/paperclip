import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
const lines = prWorkflow.split("\n");

// Upstream deleted `.github/scripts/check-pr-security.mjs` in
// paperclipai/paperclip#11828 for good reasons: it filed a GitHub draft
// security advisory per PR, posted a `neutral` check run that could not block
// by design, and accumulated 1,566 bot-authored drafts against ~99
// human-reported ones. Nothing consumed the output.
//
// This fork's situation differs in one respect that makes a gate worth having:
// the fold line runs a real CI matrix behind a merge queue with required
// checks, so a finding here can stop a merge instead of filing an advisory.
// These tests pin the wiring that makes that true. If any of them fails, the
// gate has quietly degraded back into something nobody is forced to read.

function stepBody(stepName) {
  const start = lines.findIndex((line) => line.includes(`- name: ${stepName}`));
  assert.notEqual(start, -1, `pr.yml must keep the \`${stepName}\` step`);
  const indent = lines[start].indexOf("-");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].indexOf("- name:") === indent) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Line index where a top-level `jobs:` entry begins. */
function jobStart(jobName) {
  const index = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(index, -1, `pr.yml must define the \`${jobName}\` job`);
  return index;
}

test("the security gate runs as a step of the policy job", () => {
  const body = stepBody("PR security gate");
  assert.match(body, /run: node \.\/scripts\/check-pr-security\.mjs/);

  const gateIndex = lines.findIndex((line) => line.includes("- name: PR security gate"));
  const policyIndex = jobStart("policy");
  const nextJobIndex = lines.findIndex(
    (line, index) => index > policyIndex && /^ {2}[a-z_]+:$/.test(line),
  );
  assert.ok(
    gateIndex > policyIndex && (nextJobIndex === -1 || gateIndex < nextJobIndex),
    "the gate must live in the policy job — that is what puts it upstream of every required check",
  );
});

test("the security gate binds on merge_group as well as pull_request", () => {
  const body = stepBody("PR security gate");
  // The lockfile guards next to it are deliberately `pull_request`-only. This
  // one must not be: a merge-queue entry is a different tree from the PR head,
  // and blocking the queue is the entire reason this gate exists.
  assert.doesNotMatch(
    body,
    /if:\s*github\.event_name == 'pull_request'/,
    "the security gate must not be scoped to pull_request — it has to bind in the merge queue",
  );

  assert.match(prWorkflow, /^\s{2}merge_group:$/m, "pr.yml must still run on merge_group");
});

test("a policy-job failure reaches the required checks", () => {
  // `verify` is the legacy required-check name the ruleset gates on. It
  // aggregates the heavy lanes, and every one of those `needs: [policy]`, so a
  // failed policy job skips them, `verify`'s success assertions fail, and the
  // merge queue ejects the entry. That chain — not the annotation — is what
  // makes a blocking finding actually block. Derive the lane list from the
  // workflow rather than hardcoding it, so a newly added lane is checked too.
  const verifyStart = jobStart("verify");
  const verifyNeeds = lines
    .slice(verifyStart, verifyStart + 15)
    .find((line) => line.trim().startsWith("needs: ["));
  assert.ok(verifyNeeds, "the verify job must declare its lanes via `needs:`");

  const lanes = verifyNeeds
    .slice(verifyNeeds.indexOf("[") + 1, verifyNeeds.lastIndexOf("]"))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  assert.ok(lanes.length > 0, "verify must aggregate at least one lane");

  for (const job of lanes) {
    const start = jobStart(job);
    const body = lines.slice(start, start + 15).join("\n");
    assert.match(
      body,
      /needs: \[policy\]/,
      `\`${job}\` must depend on the policy job so a security block fails \`verify\``,
    );
  }
});

test("the gate's own unit tests run in CI", () => {
  assert.match(
    stepBody("Test PR security gate"),
    /node --test \.\/scripts\/check-pr-security\.test\.mjs/,
  );
  assert.match(
    stepBody("Test PR security gate wiring"),
    /node --test \.\/scripts\/__tests__\/pr-security-gate\.test\.mjs/,
  );
});

test("the advisory-filing gate stays deleted", () => {
  // Keeping the 394-line script with no caller would read as an active
  // security control while running on zero PRs.
  for (const stale of [
    ".github/scripts/check-pr-security.mjs",
    ".github/scripts/tests/check-pr-security.test.mjs",
  ]) {
    assert.equal(existsSync(path.join(repoRoot, stale)), false, `${stale} must stay deleted`);
  }

  const commitperclip = readFileSync(
    path.join(repoRoot, ".github/workflows/commitperclip-review.yml"),
    "utf8",
  );
  assert.doesNotMatch(
    commitperclip,
    /check-pr-security\.mjs/,
    "commitperclip-review.yml must not invoke the removed advisory gate",
  );
  // Anchored to a real permission entry, not a mention: the workflow keeps a
  // comment explaining why the scope was dropped.
  assert.doesNotMatch(
    commitperclip,
    /^\s*security-events:\s*write/m,
    "the draft-advisory permission has no remaining consumer",
  );
});
