import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");

// `pnpm-lock.yaml` is CI-owned: pr.yml's policy job rejects a PR that commits it.
// Every install-bearing job therefore runs `pnpm install --frozen-lockfile` against
// the lockfile as committed on the base branch, and fails outright when that
// lockfile disagrees with the manifests on the merge ref:
//
//   ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.
//
// The disagreement is not always introduced by the PR. A base-branch commit that
// edits pnpm settings inside package.json (overrides, patchedDependencies) without
// refreshing the lockfile leaves every open PR unbuildable. The policy job's
// changed-file heuristic missed exactly that case: the PR itself had touched no
// manifest, so nothing was regenerated, no `pr-lockfile` artifact was uploaded, and
// all downstream installs died before running a line of the PR's code.
//
// These tests pin the two places that must detect drift instead of inferring it.

function jobs(workflow) {
  const lines = workflow.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) starts.push({ name: match[1], start: i });
  }
  return new Map(
    starts.map((job, index) => [
      job.name,
      lines.slice(job.start, starts[index + 1]?.start ?? lines.length).join("\n"),
    ]),
  );
}

test("pr.yml decides regeneration from a frozen-install probe, not from changed files", () => {
  const policy = jobs(prWorkflow).get("policy");
  assert.ok(policy, "pr.yml must still define a policy job");

  assert.match(
    policy,
    /pnpm install --lockfile-only --ignore-scripts --frozen-lockfile/,
    "the policy job must ask pnpm whether the committed lockfile satisfies a frozen install",
  );
  assert.match(
    policy,
    /pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile/,
    "the policy job must regenerate the lockfile when the frozen probe fails",
  );
  assert.doesNotMatch(
    policy,
    /manifest_pattern=/,
    "regeneration must not be gated on the files the PR changed: base-branch drift changes none of them",
  );
});

test("pr.yml uploads the regenerated lockfile whenever the probe regenerated one", () => {
  const policy = jobs(prWorkflow).get("policy");
  const probeIndex = policy.indexOf("--frozen-lockfile");
  const uploadIndex = policy.indexOf("name: pr-lockfile");
  assert.ok(uploadIndex !== -1, "the policy job must upload the regenerated lockfile as pr-lockfile");
  assert.ok(probeIndex !== -1 && probeIndex < uploadIndex, "the probe must run before the upload step");
  assert.match(
    policy,
    /if: steps\.regen_lockfile\.outputs\.regenerated == '1'/,
    "the upload must stay conditional on the probe having regenerated a lockfile",
  );
});

test("every install-bearing pr.yml job restores the regenerated lockfile before installing", () => {
  for (const [name, body] of jobs(prWorkflow)) {
    if (name === "policy") continue;
    if (!body.includes("pnpm install --frozen-lockfile")) continue;

    const restoreIndex = body.indexOf("name: pr-lockfile");
    assert.ok(
      restoreIndex !== -1,
      `job \`${name}\` runs a frozen install but never restores the pr-lockfile artifact`,
    );
    assert.ok(
      restoreIndex < body.indexOf("pnpm install --frozen-lockfile"),
      `job \`${name}\` must restore the pr-lockfile artifact before its frozen install`,
    );
  }
});

test("every docker.yml job that builds an image refreshes the lockfile for the build context", () => {
  for (const [name, body] of jobs(dockerWorkflow)) {
    if (!body.includes("docker/build-push-action")) continue;

    const refreshIndex = body.indexOf("pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile");
    assert.ok(
      refreshIndex !== -1,
      `job \`${name}\` builds an image whose deps stage runs a frozen install, so it must refresh the lockfile first`,
    );
    assert.ok(
      refreshIndex < body.indexOf("docker/build-push-action"),
      `job \`${name}\` must refresh the lockfile before the image build reads the build context`,
    );
  }
});
