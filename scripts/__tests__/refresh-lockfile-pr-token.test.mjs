import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/refresh-lockfile.yml"), "utf8");

// `Refresh Lockfile` authenticates both its branch push and its PR creation with the
// generated commitperclip app installation token (from TEA_CORE_APP_PRIVATE_KEY),
// not the default `GITHUB_TOKEN` — which this org blocks from creating pull requests
// ("GitHub Actions is not permitted to create or approve pull requests"). When PR
// creation is still impossible, it emits an ::error:: naming the pushed branch and the
// exact `gh pr create` command so the orphan branch is never left with no pointer.

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

test("the workflow generates a commitperclip bot token from TEA_CORE_APP_PRIVATE_KEY", () => {
  const body = stepBody("Generate commitperclip token").join("\n");
  assert.match(body, /node \.github\/scripts\/get-bot-token\.mjs/, "must invoke the bot-token generator");
  assert.match(body, /secrets\.TEA_CORE_APP_PRIVATE_KEY/, "must read the app private key secret");
});

test("the PR step uses the bot token, not the blocked GITHUB_TOKEN", () => {
  const body = stepBody("Create or update pull request").join("\n");
  assert.match(body, /GH_TOKEN:\s*\${{ steps\.bot-token\.outputs\.token }}/, "must use the generated bot token");
  assert.doesNotMatch(body, /GH_TOKEN:\s*\${{ github\.token }}/, "must not create the PR with GITHUB_TOKEN");
});

test("the generated lockfile PR includes the required review sections", () => {
  const body = stepBody("Create or update pull request").join("\n");
  for (const section of ["## Thinking Path", "## What Changed", "## Verification", "## Risks", "## Model Used"]) {
    assert.match(body, new RegExp(section.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")), `generated PR body must include ${section}`);
  }
});

test("the PR step fails loudly with the branch and the exact gh pr create command", () => {
  const body = stepBody("Create or update pull request").join("\n");
  assert.match(body, /::error title=Lockfile PR not created::/, "must emit an ::error:: annotation when the PR cannot be opened");
  assert.match(body, /Open it manually with: \$\{PR_CMD\}/, "must name the remediation command");
  assert.match(body, /pushed branch '\$\{BRANCH\}'/, "must name the pushed branch");
  assert.match(body, /PR_CMD="gh pr create --head/, "must record the exact gh pr create command");
});

// SUP-16627: the branch update was pushed with the credential that
// actions/checkout persists (GITHUB_TOKEN, i.e. github-actions[bot]). Runs raised
// by that attribution on pull_request workflows are held at action_required, so
// the PR's required checks never execute and its armed auto-merge can't progress.
// The push must instead be bound to the tea-core app installation token
// (steps.bot-token's token, exposed as GH_TOKEN in this step), and it must not run
// at all when that token is unavailable. These assertions distinguish the
// credential used for `git push` from the one used by `gh pr create`.
test("checkout does not persist the default GitHub token", () => {
  const body = stepBody("Checkout repository").join("\n");
  assert.match(body, /persist-credentials:\s*false/, "checkout must not persist GITHUB_TOKEN");
});

test("the branch push uses a temporary helper bound to the app token", () => {
  const body = stepBody("Create or update pull request").join("\n");
  assert.match(body, /PUSH_CREDENTIAL_HELPER="\$\(mktemp\)"/, "must create an ephemeral credential helper");
  assert.match(body, /password=%%s\\\\n.*\$GH_TOKEN/, "the outer printf must preserve the helper's password placeholder");
  assert.match(body, /git -c credential\.helper="!\$PUSH_CREDENTIAL_HELPER" push --force origin "\$BRANCH"/, "push must bind the helper explicitly");
  assert.doesNotMatch(body, /PUSH_URL|https:\/\/x-access-token:\$\{GH_TOKEN\}/, "must not put the token in a URL or command argument");
  assert.doesNotMatch(body, /git push[^\n]*\$\{GH_TOKEN\}/, "push must not use the token as a command argument");
});

test("the generated credential helper emits a non-empty password", () => {
  const body = stepBody("Create or update pull request");
  const command = body.find(line => line.includes("printf '#!/bin/sh"))?.trim();
  assert.ok(command, "the workflow must generate the credential helper");

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "refresh-lockfile-helper-"));
  const helperPath = path.join(tempDir, "helper.sh");
  try {
    execFileSync("sh", ["-c", command], {
      env: { ...process.env, GH_TOKEN: "test-token", PUSH_CREDENTIAL_HELPER: helperPath },
      encoding: "utf8",
    });
    const helper = readFileSync(helperPath, "utf8");
    const credentials = execFileSync("sh", [helperPath], {
      env: { ...process.env, GH_TOKEN: "test-token" },
      encoding: "utf8",
    });
    assert.match(helper, /password=%s/, "the helper source must retain its password placeholder");
    assert.match(credentials, /password=test-token/, "the helper must emit the app token as a non-empty password");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the branch push is unreachable without an app token and fails nonzero", () => {
  const body = stepBody("Create or update pull request");
  const guardIdx = body.findIndex(line => /if \[ -z "\$GH_TOKEN" \]; then/.test(line));
  const failIdx = body.findIndex((line, index) => index > guardIdx && /exit 1/.test(line));
  const guardEndIdx = body.findIndex((line, index) => index > guardIdx && line.trim() === "fi");
  const pushIdx = body.findIndex(line => /git .*push --force/.test(line));
  assert.notEqual(guardIdx, -1, "must guard the push on the app token");
  assert.notEqual(failIdx, -1, "missing app token must fail nonzero");
  assert.notEqual(guardEndIdx, -1, "token guard must close before the push");
  assert.notEqual(pushIdx, -1, "must push when the token is available");
  assert.ok(guardIdx < failIdx && failIdx < guardEndIdx && guardEndIdx < pushIdx, "push must follow the failing guard");
  assert.doesNotMatch(body.slice(guardIdx, guardEndIdx + 1).join("\n"), /git .*push/, "missing-token branch must not push");
  assert.match(body.join("\n"), /::error title=Lockfile push not performed::/, "must explain why no push occurred");
  assert.match(body.join("\n"), /was NOT pushed/, "must state that no push occurred");
});
