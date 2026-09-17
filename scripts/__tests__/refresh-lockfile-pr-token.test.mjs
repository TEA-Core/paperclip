import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/refresh-lockfile.yml"), "utf8");

// `Refresh Lockfile` opens its PR with the default `GITHUB_TOKEN`, which this org
// blocks from creating pull requests ("GitHub Actions is not permitted to create
// or approve pull requests"). The fix swaps to a commitperclip app installation
// token (generated from TEA_CORE_APP_PRIVATE_KEY) and, when PR creation is impossible,
// emits an ::error:: naming the pushed branch and the exact `gh pr create` command
// so the orphan branch is never left with no pointer. These tests pin that.

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
test("the branch push is bound to the app installation token, not the checkout-persisted credential", () => {
  const body = stepBody("Create or update pull request").join("\n");
  // The push must target a URL that embeds the generated app token as the
  // credential, so git attributes the push to the app instead of falling back to
  // the checkout-persisted default (GITHUB_TOKEN / github.token).
  assert.match(
    body,
    /PUSH_URL="https:\/\/x-access-token:\$\{GH_TOKEN\}@\[?/,
    "the push URL must embed the app installation token as its credential",
  );
  assert.match(
    body,
    /git push --force "?\$\{PUSH_URL\}"?/,
    "the branch push must push to the explicitly token-bound URL",
  );
  // The push must never rely on the checkout-persisted origin remote (which is
  // credentialed with GITHUB_TOKEN / github-actions[bot]).
  assert.doesNotMatch(
    body,
    /git push[^\n]*\sorigin\b/,
    "the branch push must not use the checkout-persisted origin credential",
  );
});

test("the branch push is gated on an available app token and fails loudly otherwise", () => {
  const body = stepBody("Create or update pull request");
  const guardIdx = body.findIndex(line => /if \[ -z "\$GH_TOKEN" \]; then/.test(line));
  const pushIdx = body.findIndex(line => /git push --force/.test(line));
  assert.notEqual(guardIdx, -1, "must guard the push on the availability of the app token");
  assert.notEqual(pushIdx, -1, "must push the branch when the token is available");
  assert.ok(guardIdx < pushIdx, "the push must only run after the app-token availability guard passes");
  // No authenticated push may run when the token is unavailable; it would recreate
  // the held-runs failure. The step must say so explicitly.
  assert.match(
    body.join("\n"),
    /::error title=Lockfile push not performed::/,
    "must emit an explicit failure when the app token is unavailable",
  );
  assert.match(
    body.join("\n"),
    /was NOT pushed/,
    "must state that no push was performed when the app token is unavailable",
  );
});
