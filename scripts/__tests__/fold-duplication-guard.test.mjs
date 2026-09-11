import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
const lines = prWorkflow.split("\n");

// A guard nobody runs is worse than no guard: it reads as an active control
// while covering zero merges. These tests pin the wiring, not the detector --
// `scripts/check-fold-duplication.test.mjs` covers the detection itself.

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

function jobStart(jobName) {
  const index = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(index, -1, `pr.yml must define the \`${jobName}\` job`);
  return index;
}

test("the guard runs as a step of the policy job", () => {
  // The range form is load-bearing: a fold PR's head is an ordinary commit and
  // the fold merge sits inside the branch, so a head-only invocation inspects
  // nothing on exactly the PRs this guard exists for.
  assert.match(
    stepBody("Fold duplication guard"),
    /run: node \.\/scripts\/check-fold-duplication\.mjs "\$HEAD_SHA" "\$BASE_SHA"/,
  );

  const gateIndex = lines.findIndex((line) => line.includes("- name: Fold duplication guard"));
  const policyIndex = jobStart("policy");
  const nextJobIndex = lines.findIndex(
    (line, index) => index > policyIndex && /^ {2}[a-z_]+:$/.test(line),
  );
  assert.ok(
    gateIndex > policyIndex && (nextJobIndex === -1 || gateIndex < nextJobIndex),
    "the guard must live in the policy job, which every required check reaches through `needs`",
  );
});

test("the guard is not scoped to a single event", () => {
  // `github.head_ref` is empty on `merge_group`, so any branch-name exemption
  // written here would silently void itself at the merge boundary -- the trap
  // already documented on the lockfile guards. The script's own two-parent
  // check is what makes it a no-op where there is nothing to inspect.
  // Comments in the step explain both traps by name, so assert on the YAML the
  // runner actually evaluates rather than on the prose next to it.
  const directives = stepBody("Fold duplication guard")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(directives, /if:\s*github\.event_name/);
  assert.doesNotMatch(directives, /github\.head_ref/);
  assert.match(prWorkflow, /^\s{2}merge_group:$/m, "pr.yml must still run on merge_group");
});

test("the guard is blocking", () => {
  // It shipped advisory in #576 so that it would not first bind on the fold
  // that was already open when it was written (#573). That fold has landed.
  // With `continue-on-error` a failing step still reads green and ejects
  // nothing, so a stray one would quietly turn the guard back into a report.
  // Assert on the directives, not the comments, which name the setting.
  const directives = stepBody("Fold duplication guard")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(directives, /continue-on-error/);
  assert.match(stepBody("Fold duplication guard"), /BLOCKING/);
});

test("the guard's own tests run in CI", () => {
  assert.match(
    stepBody("Test fold duplication guard"),
    /node --test \.\/scripts\/check-fold-duplication\.test\.mjs/,
  );
  assert.match(
    stepBody("Test fold duplication guard wiring"),
    /node --test \.\/scripts\/__tests__\/fold-duplication-guard\.test\.mjs/,
  );
  assert.ok(existsSync(path.join(repoRoot, "scripts/check-fold-duplication.mjs")));
  assert.ok(existsSync(path.join(repoRoot, "scripts/check-fold-duplication.test.mjs")));
});

test("the guard has a package.json entry point", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(
    pkg.scripts["test:check-fold-duplication"] ?? "",
    /node --test scripts\/check-fold-duplication\.test\.mjs/,
  );
});
