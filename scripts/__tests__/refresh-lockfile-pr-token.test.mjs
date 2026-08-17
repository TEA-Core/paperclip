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
// token (generated from COMMITPERCLIP_KEY) and, when PR creation is impossible,
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

test("the workflow generates a commitperclip bot token from COMMITPERCLIP_KEY", () => {
  const body = stepBody("Generate commitperclip token").join("\n");
  assert.match(body, /node \.github\/scripts\/get-bot-token\.mjs/, "must invoke the bot-token generator");
  assert.match(body, /secrets\.COMMITPERCLIP_KEY/, "must read the app private key secret");
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
