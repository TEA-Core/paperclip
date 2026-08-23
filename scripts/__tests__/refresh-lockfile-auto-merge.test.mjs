import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/refresh-lockfile.yml"), "utf8");

// `Refresh Lockfile` runs on pushes to `master` and to every `fold/**` branch,
// but the auto-merge step used to be gated on `master` only. On a fold branch
// the lockfile PR was created and then sat open forever, so the fold branch kept
// a stale `pnpm-lock.yaml` and every image build failed on the frozen install in
// `Dockerfile`. These tests pin the gate to both lines.

const lines = workflow.split("\n");

function stepBody(stepName) {
  const start = lines.findIndex(line => line.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `refresh-lockfile.yml must keep the \`${stepName}\` step`);
  const indent = lines[start].indexOf("-");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].indexOf("- name:") === indent) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

// Read the step's `if:` value, including the folded (`>-`) multi-line form.
function stepCondition(stepName) {
  const body = stepBody(stepName);
  const index = body.findIndex(line => /^\s*if:/.test(line));
  assert.notEqual(index, -1, `the \`${stepName}\` step must keep an \`if:\` gate`);
  const inline = body[index].replace(/^\s*if:\s*/, "").trim();
  if (inline && inline !== ">-" && inline !== ">" && inline !== "|") return inline;
  const ifIndent = body[index].search(/\S/);
  const continuation = [];
  for (let i = index + 1; i < body.length; i += 1) {
    const indent = body[i].search(/\S/);
    if (indent === -1 || indent <= ifIndent) break;
    continuation.push(body[i].trim());
  }
  return continuation.join(" ");
}

// Evaluate a GitHub Actions `if:` expression that only uses the operators this
// gate needs, so the test asserts on behavior instead of on exact wording.
function evaluateGate(condition, { refName, prUrl }) {
  const js = condition
    .replace(/startsWith\(([^,]+),\s*('[^']*')\)/g, "String($1).startsWith($2)")
    .replace(/github\.ref_name/g, "refName")
    .replace(/steps\.upsert-pr\.outputs\.pr_url/g, "prUrl");
  // eslint-disable-next-line no-new-func
  return Boolean(new Function("refName", "prUrl", `return (${js});`)(refName, prUrl));
}

test("the workflow still runs on master and on every fold branch", () => {
  assert.match(workflow, /^\s+- master$/m, "push trigger must keep master");
  assert.match(workflow, /^\s+- "fold\/\*\*"$/m, "push trigger must keep fold/** branches");
});

test("auto-merge is enabled for lockfile PRs on master and fold branches", () => {
  const condition = stepCondition("Enable auto-merge for lockfile PR");
  const prUrl = "https://github.com/TEA-Core/paperclip/pull/1";

  assert.equal(
    evaluateGate(condition, { refName: "master", prUrl }),
    true,
    "master lockfile PRs must keep auto-merge",
  );
  assert.equal(
    evaluateGate(condition, { refName: "fold/tea-patches-v2026.722.0", prUrl }),
    true,
    "a fold lockfile PR must get auto-merge, or the fold branch keeps a stale lockfile",
  );
  assert.equal(
    evaluateGate(condition, { refName: "chore/some-branch", prUrl }),
    false,
    "only master and fold branches may auto-merge lockfile PRs",
  );
  assert.equal(
    evaluateGate(condition, { refName: "fold/tea-patches-v2026.722.0", prUrl: "" }),
    false,
    "auto-merge must stay skipped when no lockfile PR was created",
  );
});

test("the auto-merge step arms without --delete-branch or a per-PR merge method", () => {
  const body = stepBody("Enable auto-merge for lockfile PR").join("\n");
  const cmd = body.split("\n").find(line => line.trim().startsWith("gh pr merge")) ?? "";
  assert.ok(cmd, "the auto-merge step must run a `gh pr merge` command");
  assert.match(cmd, /gh pr merge --auto/, "auto-merge must stay armed for lockfile PRs");
  // `--delete-branch` is rejected when the target branch has a merge queue
  // enabled, and on a merge-queue branch the queue owns the merge method, so
  // neither may appear in the command. Assert on the command line only (not the
  // step's comments), so the surrounding explanation cannot trip these checks.
  assert.doesNotMatch(cmd, /--delete-branch/, "no --delete-branch: rejected on merge-queue branches");
  assert.doesNotMatch(cmd, /--(squash|rebase|merge)\b/, "no per-PR merge method: the merge queue owns it");
});
