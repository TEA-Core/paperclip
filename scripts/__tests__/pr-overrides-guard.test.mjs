import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");

// PR #235 changed `pnpm.overrides` without a `pnpm-lock.yaml` update and merged,
// breaking the committed lockfile on the fold line. pr.yml's policy job masked
// this: it regenerates a throwaway `pr-lockfile` artifact so the PR's own
// `pnpm install --frozen-lockfile` steps pass, while the base it merges stays
// broken and every later queue entry dies with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
//
// These tests pin the two guards that close the hole:
//   1. the policy job fails a PR that edits `pnpm.overrides` without updating
//      the lockfile, and
//   2. install-bearing jobs restore the `pr-lockfile` artifact only when the
//      policy job actually regenerated one — never silently swallowing a missing
//      artifact with `continue-on-error`.

const lines = prWorkflow.split("\n");

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

test("the overrides guard runs in the policy job and is scoped to pull_request", () => {
  const body = stepBody("Block overrides change without lockfile update");

  assert.match(body, /node \.\/scripts\/check-overrides-lockfile\.mjs/,
    "the guard step must invoke the overrides-vs-lockfile check script");

  // Same rationale as the manual-lockfile-edit guard: a merge_group entry is
  // built on the current base and already passed this guard at PR time, and
  // `github.head_ref` is empty there. The guard must only bind on pull_request.
  assert.match(body, /if: github\.event_name == 'pull_request'/,
    "the overrides guard must be scoped to the pull_request event");
});

test("install-bearing jobs restore the pr-lockfile artifact only when the policy job regenerated one", () => {
  const restores = prWorkflow.match(/- name: Restore regenerated PR lockfile[^\n]*/g) ?? [];
  assert.ok(restores.length > 0, "pr.yml must keep its pr-lockfile restore steps");

  // Six install-bearing jobs (typecheck, general tests, build, serialized
  // server, canary dry run, e2e shards) each carry one restore step.
  assert.equal(restores.length, 6, "unexpected number of pr-lockfile restore steps");

  // A restore that runs unconditionally with `continue-on-error: true` silently
  // swallows a missing artifact — exactly the masking that let the broken base
  // through. It must be gated on the policy output instead, so a regenerated
  // lockfile is either restored or the job fails loudly.
  assert.doesNotMatch(prWorkflow, /continue-on-error: true\n\s+with:\n\s+name: pr-lockfile/,
    "no pr-lockfile restore may still use continue-on-error");

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("- name: Restore regenerated PR lockfile")) continue;
    let j = i + 1;
    const block = [];
    while (j < lines.length && lines[j].indexOf("- name:") !== lines[i].indexOf("-")) {
      block.push(lines[j]);
      j += 1;
    }
    const text = block.join("\n");
    assert.match(text, /if: needs\.policy\.outputs\.lockfile_regenerated == '1'/,
      `restore step ${i} must be gated on the policy lockfile_regenerated output`);
  }
});

test("the policy job still uploads a regenerated lockfile for downstream jobs", () => {
  const body = stepBody("Upload regenerated lockfile for downstream jobs");
  assert.match(body, /if: steps\.regen_lockfile\.outputs\.regenerated == '1'/);
  assert.match(body, /name: pr-lockfile/);
});
