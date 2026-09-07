import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  // Normalise the trailing newline: the block matchers below are line-oriented,
  // and a file whose last line has none silently truncates the last job.
  const text = readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
  return text.endsWith("\n") ? text : `${text}\n`;
}

// Text matching rather than a YAML parse, matching the sibling wiring tests in
// this directory: the policy job runs these before `pnpm install`, so they may
// not import a workspace dependency.

function jobBlock(workflow, name) {
  const match = workflow.match(new RegExp(`\\n {2}${name}:\\n((?: {4}.*\\n|\\n)*)`));
  assert.ok(match, `expected a \`${name}\` job`);
  return match[1];
}

function jobNames(workflow) {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  // GitHub Actions job ids allow uppercase and hyphens, not just the snake_case
  // this file happens to use. A narrower pattern would silently skip a job like
  // `security-scan` -- and skipping a job is exactly how one escapes the
  // reachability check below, so the narrow read makes this test pass for the
  // one case it exists to catch.
  return [...jobs.matchAll(/\n {2}([A-Za-z_][A-Za-z0-9_-]*):\n/g)].map((m) => m[1]);
}

function needsOf(block) {
  const inline = block.match(/^ {4}needs: \[([^\]]*)\]/m);
  if (inline) {
    return inline[1].split(",").map((dep) => dep.trim()).filter(Boolean);
  }
  const listed = block.match(/^ {4}needs:\n((?: {6}- .*\n)+)/m);
  if (listed) {
    return [...listed[1].matchAll(/- (\S+)/g)].map((m) => m[1]);
  }
  return [];
}

function step(block, marker) {
  // One step is everything from its `- name:` to the next `- name:` at the same
  // indent, or the end of the job.
  const steps = block.split(/\n(?= {6}- name: )/);
  return steps.find((candidate) => candidate.includes(marker));
}

// An unapproved queue entry is going to be ejected either way. What this
// precondition changes is the price: measured on PR #517, the approval verdict
// lands in ~13s while pr.yml's 23 jobs run to completion for 98.1
// runner-minutes -- thirteen times over. These tests pin the wiring, because
// every piece of it fails silently, by doing MORE work, which nothing alerts on.

test("the precondition job exists and every other job reaches it through needs", () => {
  const pr = readWorkflow("pr.yml");

  const precondition = jobBlock(pr, "approval_precondition");
  assert.ok(precondition.length > 0);
  assert.deepEqual(
    needsOf(jobBlock(pr, "policy")),
    ["approval_precondition"],
    "policy must depend on the precondition",
  );

  // `policy` is the single root of this graph, so gating it gates all 23 jobs.
  // A job added later without a needs chain back to policy escapes the
  // precondition entirely and re-opens the whole cost.
  const names = jobNames(pr);
  assert.ok(names.includes("approval_precondition"));
  const gated = new Set(["approval_precondition"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) {
      if (gated.has(name)) continue;
      const needs = needsOf(jobBlock(pr, name));
      if (needs.length > 0 && needs.every((dep) => gated.has(dep))) {
        gated.add(name);
        changed = true;
      }
    }
  }
  assert.deepEqual(
    names.filter((name) => !gated.has(name)),
    [],
    "every job must reach approval_precondition through needs",
  );
});

test("the precondition job is never skipped", () => {
  const precondition = jobBlock(readWorkflow("pr.yml"), "approval_precondition");

  // A skipped job makes its dependents skip too (SUP-13500). A job-level
  // `if: github.event_name == 'merge_group'` here would silently skip `policy`
  // -- and with it every check in this workflow -- on every pull request.
  assert.doesNotMatch(
    precondition,
    /^ {4}if:/m,
    "approval_precondition must not carry a job-level if",
  );
});

test("the precondition does its work only on merge_group", () => {
  const precondition = jobBlock(readWorkflow("pr.yml"), "approval_precondition");

  const check = step(precondition, "check-paperclip-approved.sh");
  assert.ok(check, "the precondition must run the approval check");
  assert.match(check, /check-paperclip-approved\.sh merge_group/, "in its enforcing mode");
  assert.match(check, /if: github\.event_name == 'merge_group'/);

  // A pull_request must pay a runner start and nothing more: the approval
  // status is published only at review-stage approval, which happens after CI
  // first runs on the PR, so there is nothing here for a PR event to check.
  const checkout = step(precondition, "actions/checkout");
  assert.ok(checkout, "the precondition needs a checkout to reach the script");
  assert.match(
    checkout,
    /if: github\.event_name == 'merge_group'/,
    "the checkout must be scoped to merge_group too, or every PR pays for it",
  );
});

test("the precondition can actually read what it enforces", () => {
  const precondition = jobBlock(readWorkflow("pr.yml"), "approval_precondition");

  // The script makes read-only calls to the pulls and commit-status APIs. A
  // missing scope fails the job closed on its own plumbing, which would block
  // the whole queue rather than only the unapproved entries.
  assert.match(precondition, /^ {6}contents: read$/m);
  assert.match(precondition, /^ {6}statuses: read$/m);
  assert.match(precondition, /^ {6}pull-requests: read$/m);
  assert.match(precondition, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(precondition, /GH_REPO: \$\{\{ github\.repository \}\}/);
});

test("the required aggregators still conclude when the precondition fails", () => {
  const pr = readWorkflow("pr.yml");

  // `verify` and `e2e` are the required contexts. If they did not run when
  // their dependencies are skipped, an ejected entry would wait for a report
  // that never arrives until the queue's 90-minute check timeout -- far worse
  // than the 98 runner-minutes this saves.
  for (const name of ["verify", "e2e"]) {
    const block = jobBlock(pr, name);
    assert.match(block, /if: \$\{\{ always\(\) \}\}/, `${name} must run on always()`);
    assert.match(
      block,
      /test "\$[A-Z0-9_]+_RESULT" = "success"/,
      `${name} must assert its dependencies succeeded`,
    );
  }
});

test("the precondition runs the same script as the required enforcer context", () => {
  // Two gates reading the same signal by different means would eventually
  // disagree, and the disagreement would surface as a queue ejecting entries
  // that the required context calls approved.
  const precondition = jobBlock(readWorkflow("pr.yml"), "approval_precondition");
  const enforcer = readWorkflow("paperclip-approved.yml");

  assert.match(precondition, /bash scripts\/ci\/check-paperclip-approved\.sh/);
  assert.match(enforcer, /bash scripts\/ci\/check-paperclip-approved\.sh/);
});
