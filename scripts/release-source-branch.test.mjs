import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LIB_PATH = resolve(REPO_ROOT, "scripts", "release-lib.sh");

function evalGate(branch, env = {}) {
  const script = `
    REPO_ROOT="${REPO_ROOT}"
    RELEASE_SOURCE_BRANCH="${env.RELEASE_SOURCE_BRANCH ?? "main"}"
    . "${LIB_PATH}"
    git_current_branch() { printf '%s' "${branch}"; }
    require_on_release_source_branch
    `;
  try {
    execFileSync("bash", ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.stderr?.toString().trim() ?? err.message };
  }
}

test("require_on_release_source_branch accepts the default main branch", () => {
  const result = evalGate("main");
  assert.equal(result.ok, true);
});

test("require_on_release_source_branch rejects a divergent branch", () => {
  const result = evalGate("master");
  assert.equal(result.ok, false);
  assert.match(result.message, /authoritative source branch main/);
  assert.match(result.message, /current branch is master/);
});

test("require_on_release_source_branch honors RELEASE_SOURCE_BRANCH override", () => {
  const result = evalGate("master", { RELEASE_SOURCE_BRANCH: "master" });
  assert.equal(result.ok, true);
});

test("require_on_release_source_branch rejects a non-matching override", () => {
  const result = evalGate("main", { RELEASE_SOURCE_BRANCH: "master" });
  assert.equal(result.ok, false);
  assert.match(result.message, /authoritative source branch master/);
});

const SHARED_DIST = resolve(
  REPO_ROOT,
  "packages",
  "shared",
  "dist",
  "validators",
  "issue.js",
);

test("built @paperclipai/shared issueExecutionPolicySchema exposes returnAssigneeAgentId", () => {
  const source = readFileSync(SHARED_DIST, "utf8");
  assert.match(
    source,
    /issueExecutionPolicySchema/,
    "built shared artifact must define issueExecutionPolicySchema",
  );
  assert.match(
    source,
    /returnAssigneeAgentId/,
    "built shared artifact must expose returnAssigneeAgentId inside issueExecutionPolicySchema",
  );
});
