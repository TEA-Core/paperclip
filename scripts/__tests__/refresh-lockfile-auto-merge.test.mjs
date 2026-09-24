import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/refresh-lockfile.yml"), "utf8");

// `Refresh Lockfile` runs on pushes to every `fold/**` branch, and the auto-merge
// step must stay gated on that same set. It was once gated on `master` only: the
// lockfile PR for a fold branch was created and then sat open forever, so the
// branch kept a stale `pnpm-lock.yaml` and every image build failed on the frozen
// install in `Dockerfile`. These tests pin the trigger and the gate together so
// they cannot drift apart again.
//
// `master` was deleted on 2026-09-23 (archived as `archive/master-2026-09-23`)
// after the fold lane became the default branch, so the arms that named it are
// gone from both the workflow and these assertions.

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

test("the workflow still runs on every fold branch", () => {
  assert.match(workflow, /^\s+- "fold\/\*\*"$/m, "push trigger must keep fold/** branches");
  assert.doesNotMatch(workflow, /^\s+- ["']?master["']?$/m, "master was deleted; the trigger must not name it");
});

test("auto-merge is enabled for lockfile PRs on fold branches", () => {
  const condition = stepCondition("Enable auto-merge for lockfile PR");
  const prUrl = "https://github.com/TEA-Core/paperclip/pull/1";

  assert.equal(
    evaluateGate(condition, { refName: "fold/tea-patches-v2026.722.0", prUrl }),
    true,
    "a fold lockfile PR must get auto-merge, or the fold branch keeps a stale lockfile",
  );
  assert.equal(
    evaluateGate(condition, { refName: "chore/some-branch", prUrl }),
    false,
    "only fold branches may auto-merge lockfile PRs",
  );
  assert.equal(
    evaluateGate(condition, { refName: "master", prUrl }),
    false,
    "master was deleted; no gate may still resolve true for it",
  );
  assert.equal(
    evaluateGate(condition, { refName: "fold/tea-patches-v2026.722.0", prUrl: "" }),
    false,
    "auto-merge must stay skipped when no lockfile PR was created",
  );
});

test("the auto-merge step arms with a non-interactive merge method", () => {
  const body = stepBody("Enable auto-merge for lockfile PR").join("\n");
  const cmd = body.split("\n").find(line => line.trim().startsWith("gh pr merge")) ?? "";
  assert.ok(cmd, "the auto-merge step must run a `gh pr merge` command");
  assert.match(cmd, /gh pr merge --auto/, "auto-merge must stay armed for lockfile PRs");
  assert.match(cmd, /--squash\b/, "non-interactive gh must receive the repository merge method");
  assert.doesNotMatch(cmd, /--delete-branch/, "no --delete-branch: rejected on merge-queue branches");
});
